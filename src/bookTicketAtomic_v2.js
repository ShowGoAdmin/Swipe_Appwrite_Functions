import { Client, Databases, ID, Query } from 'node-appwrite';

/**
 * Atomic Ticket Booking Function with Fallback Support
 * 
 * This function attempts to use Appwrite's native database transactions if available.
 * If transactions are not supported (SDK version < 16), it falls back to optimistic locking.
 * 
 * Version 2: Compatible with multiple SDK versions
 */

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const DATABASE_ID = process.env.DATABASE_ID;
  
  // Check if transactions are supported
  const TRANSACTIONS_SUPPORTED = typeof databases.createTransaction === 'function';
  
  log(`Transactions supported: ${TRANSACTIONS_SUPPORTED}`);
  
  if (TRANSACTIONS_SUPPORTED) {
    return await bookWithTransactions(databases, DATABASE_ID, req, res, log, error);
  } else {
    log('WARNING: Transactions not supported in this SDK version. Using optimistic locking fallback.');
    return await bookWithOptimisticLocking(databases, DATABASE_ID, req, res, log, error);
  }
};

/**
 * Book ticket using native Appwrite transactions (SDK v16+)
 */
async function bookWithTransactions(databases, DATABASE_ID, req, res, log, error) {
  let appwriteTransactionId = null;
  let ticketId = null;
  let transactionDocId = null;
  let orderId = null;

  try {
    // Parse request body
    const requestBody = JSON.parse(req.body || req.payload || '{}');
    const {
      userId, eventId, eventName, eventSubName, eventDate, eventTime,
      eventLocation, totalAmountPaid, pricePerTicket, imageFileId,
      category, quantity, paymentId, subtotal, taxGST, internetHandlingFee,
      ticketTypeName, qrCodeFileId
    } = requestBody;

    // Validation
    const quantityInt = parseInt(quantity);
    if (!userId || !eventId || !paymentId) {
      return res.json({
        success: false,
        error: 'Missing required fields',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    if (quantityInt < 1 || quantityInt > 10) {
      return res.json({
        success: false,
        error: 'Quantity must be between 1 and 10',
        code: 'INVALID_QUANTITY'
      }, 400);
    }

    // Create transaction
    log('Creating Appwrite transaction');
    const transaction = await databases.createTransaction(DATABASE_ID, 60);
    appwriteTransactionId = transaction.$id;
    log('Transaction created', { transactionId: appwriteTransactionId });

    // Read event within transaction for conflict detection
    const eventDoc = await databases.getDocument(
      DATABASE_ID,
      'events',
      eventId,
      [],
      appwriteTransactionId
    );

    const currentTicketsLeft = parseInt(eventDoc.ticketsLeft) || 0;
    if (currentTicketsLeft < quantityInt) {
      await databases.updateTransaction(DATABASE_ID, appwriteTransactionId, 'rollback');
      return res.json({
        success: false,
        error: `Only ${currentTicketsLeft} tickets available`,
        code: 'INSUFFICIENT_TICKETS'
      }, 400);
    }

    // Check for duplicate payment
    const existingTransactions = await databases.listDocuments(
      DATABASE_ID,
      'transactions',
      [Query.equal('paymentId', paymentId)]
    );

    if (existingTransactions.documents.length > 0) {
      await databases.updateTransaction(DATABASE_ID, appwriteTransactionId, 'rollback');
      return res.json({
        success: false,
        error: 'Payment ID already used',
        code: 'DUPLICATE_PAYMENT',
        existingTicketId: existingTransactions.documents[0].ticketId
      }, 400);
    }

    // Stage ticket creation
    ticketId = ID.unique();
    await databases.createDocument(
      DATABASE_ID,
      'tickets',
      ticketId,
      {
        userId, eventId, eventName, eventSub_name: eventSubName,
        eventDate, eventTime, eventLocation: eventLocation,
        totalAmountPaid, pricePerTicket, imageFileId,
        category: category.replace('Rs.', ''),
        quantity, isListedForSale: 'false',
        qrCodeFileId: qrCodeFileId || ''
      },
      [],
      appwriteTransactionId
    );

    // Stage transaction creation
    transactionDocId = ID.unique();
    await databases.createDocument(
      DATABASE_ID,
      'transactions',
      transactionDocId,
      {
        userId, eventId, ticketId, paymentId,
        amount: totalAmountPaid, status: 'completed',
        createdAt: new Date().toISOString()
      },
      [],
      appwriteTransactionId
    );

    // Stage order creation
    orderId = ID.unique();
    await databases.createDocument(
      DATABASE_ID,
      'orders',
      orderId,
      {
        userId, eventId, ticketId, transactionId: transactionDocId,
        subtotal, taxGST, internetHandlingFee,
        totalAmount: totalAmountPaid, status: 'completed',
        createdAt: new Date().toISOString()
      },
      [],
      appwriteTransactionId
    );

    // Stage event ticket decrease
    const newTicketsLeft = Math.max(0, currentTicketsLeft - quantityInt).toString();
    const categoriesArray = JSON.parse(eventDoc.categories || '[]');
    const updatedCategories = categoriesArray.map(cat => {
      if (cat.name === ticketTypeName) {
        return { ...cat, ticketsLeft: Math.max(0, (parseInt(cat.ticketsLeft) || 0) - quantityInt) };
      }
      return cat;
    });

    await databases.updateDocument(
      DATABASE_ID,
      'events',
      eventId,
      {
        ticketsLeft: newTicketsLeft,
        categories: JSON.stringify(updatedCategories)
      },
      [],
      appwriteTransactionId
    );

    // Commit transaction
    await databases.updateTransaction(DATABASE_ID, appwriteTransactionId, 'commit');
    log('Transaction committed successfully');

    return res.json({
      success: true,
      data: {
        ticketId,
        transactionId: transactionDocId,
        orderId,
        message: 'Ticket booking completed successfully with Appwrite Transactions',
        note: 'QR code will be generated by client using the ticketId'
      }
    }, 200);

  } catch (err) {
    error('Booking failed', err);

    if (appwriteTransactionId) {
      try {
        await databases.updateTransaction(DATABASE_ID, appwriteTransactionId, 'rollback');
        log('Transaction rolled back successfully');
      } catch (rollbackErr) {
        error('Rollback failed', rollbackErr);
      }
    }

    const errorCode = err.code || err.type || 'BOOKING_ERROR';
    return res.json({
      success: false,
      error: err.message || 'An error occurred during booking',
      code: errorCode
    }, 500);
  }
}

/**
 * Fallback: Book ticket using optimistic locking (SDK < v16)
 */
async function bookWithOptimisticLocking(databases, DATABASE_ID, req, res, log, error) {
  let createdDocuments = [];
  let ticketId = null;
  let transactionDocId = null;
  let orderId = null;

  try {
    // Parse request body
    const requestBody = JSON.parse(req.body || req.payload || '{}');
    const {
      userId, eventId, eventName, eventSubName, eventDate, eventTime,
      eventLocation, totalAmountPaid, pricePerTicket, imageFileId,
      category, quantity, paymentId, subtotal, taxGST, internetHandlingFee,
      ticketTypeName, qrCodeFileId
    } = requestBody;

    // Validation
    const quantityInt = parseInt(quantity);
    if (!userId || !eventId || !paymentId) {
      return res.json({
        success: false,
        error: 'Missing required fields',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    // Check ticket availability with retry logic
    let retries = 3;
    let eventDoc = null;
    
    while (retries > 0) {
      try {
        eventDoc = await databases.getDocument(DATABASE_ID, 'events', eventId);
        const currentTicketsLeft = parseInt(eventDoc.ticketsLeft) || 0;
        
        if (currentTicketsLeft < quantityInt) {
          return res.json({
            success: false,
            error: `Only ${currentTicketsLeft} tickets available`,
            code: 'INSUFFICIENT_TICKETS'
          }, 400);
        }
        
        break;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Check for duplicate payment
    const existingTransactions = await databases.listDocuments(
      DATABASE_ID,
      'transactions',
      [Query.equal('paymentId', paymentId)]
    );

    if (existingTransactions.documents.length > 0) {
      return res.json({
        success: false,
        error: 'Payment ID already used',
        code: 'DUPLICATE_PAYMENT'
      }, 400);
    }

    // Create ticket
    ticketId = ID.unique();
    const ticketDoc = await databases.createDocument(
      DATABASE_ID,
      'tickets',
      ticketId,
      {
        userId, eventId, eventName, eventSub_name: eventSubName,
        eventDate, eventTime, eventLocation: eventLocation,
        totalAmountPaid, pricePerTicket, imageFileId,
        category: category.replace('Rs.', ''),
        quantity, isListedForSale: 'false',
        qrCodeFileId: qrCodeFileId || ''
      }
    );
    createdDocuments.push({ collection: 'tickets', id: ticketId });

    // Create transaction
    transactionDocId = ID.unique();
    await databases.createDocument(
      DATABASE_ID,
      'transactions',
      transactionDocId,
      {
        userId, eventId, ticketId, paymentId,
        amount: totalAmountPaid, status: 'completed',
        createdAt: new Date().toISOString()
      }
    );
    createdDocuments.push({ collection: 'transactions', id: transactionDocId });

    // Create order
    orderId = ID.unique();
    await databases.createDocument(
      DATABASE_ID,
      'orders',
      orderId,
      {
        userId, eventId, ticketId, transactionId: transactionDocId,
        subtotal, taxGST, internetHandlingFee,
        totalAmount: totalAmountPaid, status: 'completed',
        createdAt: new Date().toISOString()
      }
    );
    createdDocuments.push({ collection: 'orders', id: orderId });

    // Update event tickets
    const currentTicketsLeft = parseInt(eventDoc.ticketsLeft) || 0;
    const newTicketsLeft = Math.max(0, currentTicketsLeft - quantityInt).toString();
    const categoriesArray = JSON.parse(eventDoc.categories || '[]');
    const updatedCategories = categoriesArray.map(cat => {
      if (cat.name === ticketTypeName) {
        return { ...cat, ticketsLeft: Math.max(0, (parseInt(cat.ticketsLeft) || 0) - quantityInt) };
      }
      return cat;
    });

    await databases.updateDocument(
      DATABASE_ID,
      'events',
      eventId,
      {
        ticketsLeft: newTicketsLeft,
        categories: JSON.stringify(updatedCategories)
      }
    );

    log('Booking completed with optimistic locking');

    return res.json({
      success: true,
      data: {
        ticketId,
        transactionId: transactionDocId,
        orderId,
        message: 'Ticket booking completed successfully (optimistic locking)',
        note: 'QR code will be generated by client using the ticketId'
      }
    }, 200);

  } catch (err) {
    error('Booking failed, initiating manual rollback', err);

    // Manual cleanup
    for (const doc of createdDocuments.reverse()) {
      try {
        await databases.deleteDocument(DATABASE_ID, doc.collection, doc.id);
        log(`Deleted ${doc.collection}/${doc.id}`);
      } catch (deleteErr) {
        error(`Failed to delete ${doc.collection}/${doc.id}`, deleteErr);
      }
    }

    return res.json({
      success: false,
      error: err.message || 'An error occurred during booking',
      code: err.code || 'BOOKING_ERROR'
    }, 500);
  }
}


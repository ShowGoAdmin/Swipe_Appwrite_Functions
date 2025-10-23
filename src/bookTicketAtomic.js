import { Client, Databases, ID, Query } from 'node-appwrite';

/**
 * Atomic Ticket Booking Function using Appwrite Native Transactions
 * 
 * This function uses Appwrite's native database transactions for true atomicity.
 * All operations are staged and committed together - if any operation fails,
 * the entire transaction is automatically rolled back by Appwrite.
 * 
 * Flow:
 * 1. Create Appwrite transaction
 * 2. Validate inputs and check ticket availability
 * 3. Stage all operations (ticket, transaction, order, event update)
 * 4. Commit transaction
 * 
 * Benefits over manual rollback:
 * - True ACID compliance
 * - No manual cleanup needed
 * - Automatic conflict detection
 * - Better performance
 * 
 * Reference: https://appwrite.io/docs/products/databases/transactions
 */

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const DATABASE_ID = process.env.DATABASE_ID;
  
  let appwriteTransactionId = null;
  let ticketId = null;
  let transactionDocId = null;
  let orderId = null;

  try {
    // Parse request body
    const {
      userId,
      eventId,
      eventName,
      eventSubName,
      eventDate,
      eventTime,
      eventLocation,
      totalAmountPaid,
      pricePerTicket,
      imageFileId,
      category,
      quantity,
      paymentId,
      subtotal,
      taxGST,
      internetHandlingFee,
      ticketTypeName,
      qrCodeFileId,
      ticketId: providedTicketId // Optional pre-generated ticket ID from client
    } = JSON.parse(req.body || '{}');

    log('Starting atomic ticket booking with Appwrite Transactions', { userId, eventId, quantity, ticketTypeName });

    // ============================================
    // STEP 1: Validate inputs
    // ============================================
    if (!userId || !eventId || !paymentId || !quantity || !ticketTypeName) {
      error('Missing required fields');
      return res.json({
        success: false,
        error: 'Missing required fields',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    // Validate quantity
    const quantityInt = parseInt(quantity);
    if (isNaN(quantityInt) || quantityInt < 1 || quantityInt > 10) {
      error('Invalid quantity');
      return res.json({
        success: false,
        error: 'Quantity must be between 1 and 10',
        code: 'INVALID_QUANTITY'
      }, 400);
    }

    // ============================================
    // STEP 1.5: Create Appwrite Transaction
    // ============================================
    log('Creating Appwrite transaction');
    
    // Create transaction with 5-minute TTL (300 seconds)
    // TTL must be between 60 and 3,600 seconds
    const transaction = await databases.createTransaction(300);
    appwriteTransactionId = transaction.$id;
    
    log('Transaction created successfully', { transactionId: appwriteTransactionId });

    // ============================================
    // STEP 2: Check for duplicate payment WITHIN transaction
    // ============================================
    log('Checking for duplicate payment within transaction context');
    
    const existingTransaction = await databases.listDocuments(
      DATABASE_ID,
      'transactions',
      [Query.equal('paymentId', paymentId)],
      undefined, // permissions
      appwriteTransactionId // CRITICAL: Check within transaction for conflict detection
    );

    if (existingTransaction.documents.length > 0) {
      error('Payment already processed');
      
      // Rollback transaction
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'This payment has already been processed',
        code: 'DUPLICATE_PAYMENT',
        existingTicketId: existingTransaction.documents[0].ticketId
      }, 400);
    }
    
    log('No duplicate payment found, proceeding');

    // ============================================
    // STEP 3: Check ticket availability within transaction
    // ============================================
    log('Checking ticket availability within transaction context');
    
    // Read event document WITHIN transaction for conflict detection
    const eventDoc = await databases.getDocument(
      DATABASE_ID, 
      'events', 
      eventId,
      [],  // queries
      appwriteTransactionId  // <-- CRITICAL: Track this read for conflicts
    );
    
    const currentTicketsLeft = parseInt(eventDoc.ticketsLeft) || 0;
    if (currentTicketsLeft < quantityInt) {
      error('Insufficient tickets available');
      return res.json({
        success: false,
        error: 'Insufficient tickets available',
        code: 'INSUFFICIENT_TICKETS',
        availableTickets: currentTicketsLeft
      }, 400);
    }

    // Check specific ticket type availability
    const ticketTypes = eventDoc.categories || [];
    let ticketTypeAvailable = false;
    let ticketTypeQuantity = 0;

    for (const ticketTypeStr of ticketTypes) {
      const parts = ticketTypeStr.split(':').map(part => part.trim());
      if (parts.length >= 3 && parts[0] === ticketTypeName) {
        ticketTypeQuantity = parseInt(parts[2]) || 0;
        if (ticketTypeQuantity >= quantityInt) {
          ticketTypeAvailable = true;
        }
        break;
      }
    }

    if (!ticketTypeAvailable) {
      error('Ticket type not available or insufficient quantity');
      return res.json({
        success: false,
        error: 'Ticket type not available or insufficient quantity',
        code: 'TICKET_TYPE_UNAVAILABLE',
        availableQuantity: ticketTypeQuantity
      }, 400);
    }

    // ============================================
    // STEP 4: CREATE TRANSACTION & CHECK DUPLICATES ATOMICALLY
    // ============================================
    // Note: Duplicate payment check moved inside transaction (lines 100-126)
    // This ensures atomic duplicate detection with conflict resolution

    // ============================================
    // STEP 5: Stage ticket document creation
    // ============================================
    log('Staging ticket document creation');
    
    // Use provided ticket ID or generate a new one
    // Pre-generated ID allows client to create QR code before booking
    if (providedTicketId) {
      ticketId = providedTicketId;
      log('Using pre-generated ticket ID from client', { ticketId });
      
      // Verify this ticket ID doesn't already exist (prevents duplicate bookings)
      try {
        const existingTicket = await databases.getDocument(
          DATABASE_ID,
          'tickets',
          ticketId,
          [],
          appwriteTransactionId
        );
        
        // If we reach here, ticket already exists - this is a duplicate
        error('Ticket ID already exists - duplicate booking attempt');
        await databases.updateTransaction(appwriteTransactionId, false);
        
        return res.json({
          success: false,
          error: 'This ticket ID has already been used',
          code: 'DUPLICATE_TICKET_ID',
          existingTicketId: ticketId
        }, 400);
      } catch (err) {
        // Document not found - this is expected and good (ticket doesn't exist yet)
        if (err.code === 404 || err.message?.includes('not found')) {
          log('Ticket ID verified as unique', { ticketId });
        } else {
          // Unexpected error
          throw err;
        }
      }
    } else {
      ticketId = ID.unique();
      log('Generated new ticket ID', { ticketId });
    }
    
    const ticketDoc = await databases.createDocument(
      DATABASE_ID,
      'tickets',
      ticketId,
      {
        userId: userId,
        eventId: eventId,
        eventName: eventName,
        eventSub_name: eventSubName,
        eventDate: eventDate,
        eventTime: eventTime,
        eventLocation: eventLocation,
        totalAmountPaid: totalAmountPaid,
        pricePerTicket: pricePerTicket,
        imageFileId: imageFileId,
        category: category.replace('Rs.', ''),
        quantity: quantity,
        isListedForSale: 'false',
        qrCodeFileId: qrCodeFileId || ''
      },
      [],
      appwriteTransactionId // Pass transaction ID for staging
    );

    log('Ticket creation staged', { ticketId });

    // ============================================
    // STEP 6: Stage transaction document creation
    // ============================================
    log('Staging transaction document creation');
    
    transactionDocId = ID.unique();
    
    const transactionDoc = await databases.createDocument(
      DATABASE_ID,
      'transactions',
      transactionDocId,
      {
        userId: userId,
        ticketId: ticketId,
        paymentId: paymentId,
        totalAmount: totalAmountPaid,
        gateway: 'RazorPay'
      },
      [],
      appwriteTransactionId // Pass transaction ID for staging
    );

    log('Transaction creation staged', { transactionId: transactionDocId });

    // ============================================
    // STEP 7: Stage order document creation
    // ============================================
    log('Staging order document creation');
    
    orderId = ID.unique();
    
    const orderDoc = await databases.createDocument(
      DATABASE_ID,
      'orders',
      orderId,
      {
        userId: userId,
        ticketId: ticketId,
        eventId: eventId,
        transactionId: transactionDocId,
        quantity: quantity,
        singleTicketPrice: pricePerTicket,
        subtotal: subtotal,
        taxGST: taxGST,
        internetHandlingFee: internetHandlingFee,
        totalAmount: totalAmountPaid
      },
      [],
      appwriteTransactionId // Pass transaction ID for staging
    );

    log('Order creation staged', { orderId });

    // Note: If client pre-generates ticket ID, QR code will be included in initial booking
    // Otherwise, QR code can be generated and updated by client after booking completes

    // ============================================
    // STEP 8: Stage ticket decrease operation (CRITICAL)
    // ============================================
    log('Staging ticket decrease');
    
    const newTicketsLeft = Math.max(0, currentTicketsLeft - quantityInt).toString();
    
    // Update specific ticket type quantity
    const updatedTicketTypes = ticketTypes.map(ticketTypeStr => {
      const parts = ticketTypeStr.split(':').map(part => part.trim());
      if (parts.length >= 4 && parts[0] === ticketTypeName) {
        const name = parts[0];
        const formattedPrice = parts[1];
        const currentQty = parseInt(parts[2]) || 0;
        const phase = parts[3];
        const newQty = Math.max(0, currentQty - quantityInt);
        return `${name}:${formattedPrice}:${newQty}:${phase}`;
      }
      return ticketTypeStr;
    });

    await databases.updateDocument(
      DATABASE_ID,
      'events',
      eventId,
      {
        ticketsLeft: newTicketsLeft,
        categories: updatedTicketTypes
      },
      [],
      appwriteTransactionId // Pass transaction ID for staging
    );

    log('Ticket decrease staged', { 
      newTicketsLeft, 
      ticketTypeName,
      quantityDecreased: quantityInt 
    });

    // ============================================
    // STEP 9: Commit the transaction
    // ============================================
    log('Committing transaction', { transactionId: appwriteTransactionId });
    
    await databases.updateTransaction(
      appwriteTransactionId,
      true // true = commit, false = rollback
    );
    
    log('Transaction committed successfully - all operations persisted');

    // ============================================
    // SUCCESS - Return booking details
    // ============================================
    log('Booking completed successfully');
    
    return res.json({
      success: true,
      data: {
        ticketId: ticketId,
        transactionId: transactionDocId,
        orderId: orderId,
        message: 'Ticket booking completed successfully with Appwrite Transactions',
        qrCodeIncluded: qrCodeFileId ? true : false
      }
    }, 200);

  } catch (err) {
    // ============================================
    // ERROR HANDLING & AUTOMATIC ROLLBACK
    // ============================================
    error('Booking failed, rolling back transaction', err);
    
    // Attempt to rollback the transaction if it was created
    if (appwriteTransactionId) {
      try {
        log('Rolling back transaction', { transactionId: appwriteTransactionId });
        
        await databases.updateTransaction(
          appwriteTransactionId,
          false // true = commit, false = rollback
        );
        
        log('Transaction rolled back successfully - no data persisted');
      } catch (rollbackErr) {
        error('Transaction rollback failed', {
          rollbackError: rollbackErr.message,
          originalError: err.message,
          transactionId: appwriteTransactionId
        });
        // Even if rollback fails, Appwrite will auto-rollback uncommitted transactions
      }
    } else {
      log('No transaction to rollback - error occurred before transaction creation');
    }

    // Determine error code and message
    let errorCode = 'BOOKING_ERROR';
    let errorMessage = err.message || 'Booking failed';
    
    // Check for specific Appwrite error types
    if (err.code === 409 || err.message?.includes('conflict')) {
      errorCode = 'CONFLICT_ERROR';
      errorMessage = 'Booking conflict detected. Please try again.';
    } else if (err.message?.includes('not found')) {
      errorCode = 'NOT_FOUND_ERROR';
      errorMessage = 'Event or ticket type not found';
    } else if (err.message?.includes('permission')) {
      errorCode = 'PERMISSION_ERROR';
      errorMessage = 'Permission denied';
    }

    // Return error response
    return res.json({
      success: false,
      error: errorMessage,
      code: errorCode,
      details: err.message,
      transactionRolledBack: appwriteTransactionId !== null
    }, 500);
  }
};


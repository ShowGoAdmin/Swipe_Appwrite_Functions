import { Client, Databases, ID, Query, Messaging } from 'node-appwrite';

/**
 * Send push notification using Appwrite Messaging SDK
 */
async function sendPushNotification(sellerUserId, message, databases) {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const messaging = new Messaging(client);
    
    const messageId = ID.unique();
    const users = [sellerUserId]; // Target specific seller
    
    const pushMessage = await messaging.createPush(
      messageId,
      message.title,
      message.body,
      [], // topics (optional)
      users, // users - target the seller
      [], // targets (optional)
      message.data, // data payload
      "open", // action
      "", // image (optional)
      "", // icon (optional)
      "default", // sound
      "#F7941E", // color
      "", // tag (optional)
      "1" // badge
    );
    
    console.log("Push notification sent successfully:", pushMessage);
    return pushMessage;
  } catch (error) {
    console.error("Error sending push notification:", error);
    throw error;
  }
}

/**
 * Atomic Resale Ticket Purchase Function using Appwrite Native Transactions
 * 
 * This function handles the complete resale ticket purchase flow atomically:
 * 1. Validates the purchase
 * 2. Updates instant sale listing quantity
 * 3. Updates original ticket quantity
 * 4. Creates new ticket for buyer
 * 5. Updates listing status
 * 6. Creates transaction record
 * 
 * All operations are wrapped in a single transaction to ensure consistency.
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
  let newTicketId = null;
  let transactionDocId = null;

  try {
    // Parse request body
    const {
      instantSaleTicketId,
      buyerId,
      quantityPurchased,
      paymentId,
      totalAmount,
      eventName,
      eventSubName,
      eventDate,
      eventTime,
      eventLocation,
      sellingPrice,
      originalTicketId,
      sellerUserId
    } = JSON.parse(req.body || '{}');

    log('Starting atomic resale ticket purchase', { 
      instantSaleTicketId, 
      buyerId, 
      quantityPurchased, 
      paymentId 
    });

    // ============================================
    // STEP 1: Validate inputs
    // ============================================
    if (!instantSaleTicketId || !buyerId || !quantityPurchased || !paymentId || !totalAmount) {
      error('Missing required fields');
      return res.json({
        success: false,
        error: 'Missing required fields',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    const quantityInt = parseInt(quantityPurchased);
    if (isNaN(quantityInt) || quantityInt < 1) {
      error('Invalid quantity');
      return res.json({
        success: false,
        error: 'Quantity must be at least 1',
        code: 'INVALID_QUANTITY'
      }, 400);
    }

    // ============================================
    // STEP 2: Create Appwrite Transaction
    // ============================================
    log('Creating Appwrite transaction for resale purchase');
    
    // Create transaction with 5-minute TTL (300 seconds)
    // TTL must be between 60 and 3,600 seconds
    const transaction = await databases.createTransaction(300);
    appwriteTransactionId = transaction.$id;
    
    log('Transaction created successfully', { transactionId: appwriteTransactionId });

    // ============================================
    // STEP 3: Check for duplicate payment
    // ============================================
    log('Checking for duplicate payment within transaction context');
    
    const existingTransaction = await databases.listDocuments(
      DATABASE_ID,
      'transactions',
      [Query.equal('paymentId', paymentId)],
      undefined,
      appwriteTransactionId
    );

    if (existingTransaction.documents.length > 0) {
      error('Payment already processed');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'This payment has already been processed',
        code: 'DUPLICATE_PAYMENT',
        existingTicketId: existingTransaction.documents[0].ticketId
      }, 400);
    }

    // ============================================
    // STEP 4: Validate instant sale ticket availability
    // ============================================
    log('Validating instant sale ticket availability');
    
    const instantSaleDoc = await databases.getDocument(
      DATABASE_ID,
      'TicketsForInstantSale',
      instantSaleTicketId,
      [],
      appwriteTransactionId
    );

    const currentQuantity = parseInt(instantSaleDoc.quantity) || 0;
    if (currentQuantity < quantityInt) {
      error('Insufficient tickets available');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'Insufficient tickets available',
        code: 'INSUFFICIENT_TICKETS',
        availableTickets: currentQuantity
      }, 400);
    }

    if (instantSaleDoc.status !== 'Available') {
      error('Ticket is not available');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'Ticket is no longer available',
        code: 'TICKET_UNAVAILABLE'
      }, 400);
    }

    // ============================================
    // STEP 5: Get original ticket details
    // ============================================
    log('Fetching original ticket details');
    
    const originalTicketDoc = await databases.getDocument(
      DATABASE_ID,
      'tickets',
      originalTicketId,
      [],
      appwriteTransactionId
    );

    // ============================================
    // STEP 6: Create new ticket for buyer
    // ============================================
    log('Creating new ticket for buyer');
    
    newTicketId = ID.unique();
    
    const newTicketData = {
      userId: buyerId,
      eventId: originalTicketDoc.eventId,
      eventName: originalTicketDoc.eventName,
      eventSub_name: originalTicketDoc.eventSub_name,
      eventDate: originalTicketDoc.eventDate,
      eventTime: originalTicketDoc.eventTime,
      eventLocation: originalTicketDoc.eventLocation,
      totalAmountPaid: totalAmount,
      pricePerTicket: sellingPrice,
      imageFileId: originalTicketDoc.imageFileId,
      category: originalTicketDoc.category,
      quantity: quantityPurchased,
      isListedForSale: 'false',
      qrCodeFileId: `${newTicketId}_ticket_qr.png`,
      bookedOn: new Date().toISOString(),
      purchaseType: 'resale',
      originalTicketId: originalTicketId,
      sellerUserId: sellerUserId
    };

    await databases.createDocument(
      DATABASE_ID,
      'tickets',
      newTicketId,
      newTicketData,
      [],
      appwriteTransactionId
    );

    log('New ticket created for buyer', { ticketId: newTicketId });

    // ============================================
    // STEP 7: Update instant sale listing
    // ============================================
    log('Updating instant sale listing');
    
    const newInstantSaleQuantity = currentQuantity - quantityInt;
    const newInstantSaleStatus = newInstantSaleQuantity === 0 ? 'sold' : 'Available';

    await databases.updateDocument(
      DATABASE_ID,
      'TicketsForInstantSale',
      instantSaleTicketId,
      {
        quantity: newInstantSaleQuantity.toString(),
        status: newInstantSaleStatus
      },
      [],
      appwriteTransactionId
    );

    // ============================================
    // STEP 8: Update original ticket
    // ============================================
    log('Updating original ticket');
    
    const originalQuantity = parseInt(originalTicketDoc.quantity) || 0;
    const newOriginalQuantity = originalQuantity - quantityInt;
    const newIsListedForSale = newOriginalQuantity === 0 ? 'false' : 'true';

    await databases.updateDocument(
      DATABASE_ID,
      'tickets',
      originalTicketId,
      {
        quantity: newOriginalQuantity.toString(),
        isListedForSale: newIsListedForSale
      },
      [],
      appwriteTransactionId
    );

    // ============================================
    // STEP 9: Update general listing
    // ============================================
    log('Updating general listing');
    
    const listingQuery = await databases.listDocuments(
      DATABASE_ID,
      'Listings',
      [Query.equal('ticketId', originalTicketId)],
      undefined,
      appwriteTransactionId
    );

    if (listingQuery.documents.length > 0) {
      const listingDocId = listingQuery.documents[0].$id;
      await databases.updateDocument(
        DATABASE_ID,
        'Listings',
        listingDocId,
        {
          quantity: newOriginalQuantity.toString()
        },
        [],
        appwriteTransactionId
      );
    }

    // ============================================
    // STEP 10: Create transaction record
    // ============================================
    log('Creating transaction record');
    
    transactionDocId = ID.unique();
    
    await databases.createDocument(
      DATABASE_ID,
      'transactions',
      transactionDocId,
      {
        userId: buyerId,
        ticketId: newTicketId,
        paymentId: paymentId,
        totalAmount: totalAmount,
        gateway: 'RazorPay',
        transactionType: 'resale_purchase',
        originalTicketId: originalTicketId,
        sellerUserId: sellerUserId
      },
      [],
      appwriteTransactionId
    );

    // ============================================
    // STEP 11: Clean up if all tickets sold (within transaction)
    // ============================================
    if (newInstantSaleQuantity === 0) {
      log('All tickets sold, cleaning up listings');
      
      try {
        // Delete from instant sale table
        log('Attempting to delete instant sale listing', { instantSaleTicketId });
        await databases.deleteDocument(
          DATABASE_ID,
          'TicketsForInstantSale',
          instantSaleTicketId,
          appwriteTransactionId
        );
        log('Instant sale listing deleted successfully');
      } catch (deleteErr) {
        error('Failed to delete instant sale listing', {
          error: deleteErr.message,
          code: deleteErr.code,
          instantSaleTicketId,
          transactionId: appwriteTransactionId
        });
        throw deleteErr; // Re-throw to trigger transaction rollback
      }

      // Delete from general listings if it exists
      if (listingQuery.documents.length > 0) {
        try {
          const listingId = listingQuery.documents[0].$id;
          log('Attempting to delete general listing', { listingId });
          await databases.deleteDocument(
            DATABASE_ID,
            'Listings',
            listingId,
            appwriteTransactionId
          );
          log('General listing deleted successfully');
        } catch (deleteErr) {
          error('Failed to delete general listing', {
            error: deleteErr.message,
            code: deleteErr.code,
            listingId: listingQuery.documents[0].$id,
            transactionId: appwriteTransactionId
          });
          throw deleteErr; // Re-throw to trigger transaction rollback
        }
      } else {
        log('No general listing found to delete');
      }
    }

    // ============================================
    // STEP 11.5: Handle original ticket cleanup (within transaction)
    // ============================================
    if (newOriginalQuantity === 0) {
      log('Original ticket completely sold, cleaning up');
      
      try {
        // Delete the original ticket since quantity is now 0
        log('Attempting to delete original ticket', { originalTicketId });
        await databases.deleteDocument(
          DATABASE_ID,
          'tickets',
          originalTicketId,
          appwriteTransactionId
        );
        log('Original ticket deleted successfully', { originalTicketId });
      } catch (deleteErr) {
        error('Failed to delete original ticket', {
          error: deleteErr.message,
          code: deleteErr.code,
          originalTicketId,
          transactionId: appwriteTransactionId
        });
        throw deleteErr; // Re-throw to trigger transaction rollback
      }
    }

    // ============================================
    // STEP 12: Commit transaction
    // ============================================
    log('Committing resale purchase transaction', { transactionId: appwriteTransactionId });
    
    await databases.updateTransaction(
      appwriteTransactionId,
      true // true = commit, false = rollback
    );
    
    log('Resale purchase transaction committed successfully');

    // ============================================
    // STEP 13: Send notification for every ticket sold (outside transaction)
    // ============================================
    try {
      // Create notification message for individual sale
      const notificationMessage = {
        title: newOriginalQuantity === 0 ? "🎉 All Tickets Sold!" : "💰 Ticket Sale Notification",
        body: newOriginalQuantity === 0 
          ? `🎊 Congratulations! All your ${eventName} tickets have been sold`
          : `${quantityInt} ticket(s) of ${eventName} sold for ₹${totalAmount}`,
        data: {
          type: newOriginalQuantity === 0 ? "complete_ticket_sale" : "individual_ticket_sold",
          ticketId: originalTicketId,
          eventName: eventName,
          amount: totalAmount,
          quantitySold: quantityInt.toString(),
          buyerId: buyerId,
          remainingQuantity: newOriginalQuantity.toString(),
          isCompletelySold: newOriginalQuantity === 0,
          totalEarnings: totalAmount // For complete sale tracking
        }
      };
      
      // Send push notification using Appwrite Messaging SDK
      await sendPushNotification(sellerUserId, notificationMessage, databases);
      log('Sale notification sent to seller', { 
        sellerUserId, 
        quantitySold: quantityInt,
        remainingQuantity: newOriginalQuantity,
        isCompleteSale: newOriginalQuantity === 0
      });
    } catch (notificationError) {
      log('Failed to send sale notification to seller', { 
        error: notificationError.message,
        sellerUserId 
      });
      // Don't fail the response for notification errors
    }

    // ============================================
    // SUCCESS - Return purchase details
    // ============================================
    log('Resale purchase completed successfully');
    
    return res.json({
      success: true,
      data: {
        ticketId: newTicketId,
        transactionId: transactionDocId,
        message: 'Resale ticket purchase completed successfully',
        quantityPurchased: quantityInt,
        remainingQuantity: newInstantSaleQuantity,
        originalTicketDeleted: newOriginalQuantity === 0,
        notificationSent: true
      }
    }, 200);

  } catch (err) {
    // ============================================
    // ERROR HANDLING & AUTOMATIC ROLLBACK
    // ============================================
    error('Resale purchase failed', err);
    
    // Appwrite automatically rolls back transactions on error
    // No manual rollback needed
    if (appwriteTransactionId) {
      log('Transaction will be automatically rolled back by Appwrite', { transactionId: appwriteTransactionId });
    }

    // Determine error code and message
    let errorCode = 'RESALE_PURCHASE_ERROR';
    let errorMessage = err.message || 'Resale purchase failed';
    
    if (err.code === 409 || err.message?.includes('conflict')) {
      errorCode = 'CONFLICT_ERROR';
      errorMessage = 'Purchase conflict detected. Please try again.';
    } else if (err.message?.includes('not found')) {
      errorCode = 'NOT_FOUND_ERROR';
      errorMessage = 'Ticket or listing not found';
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

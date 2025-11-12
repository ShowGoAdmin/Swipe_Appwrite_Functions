import { Client, Databases, ID, Query } from 'node-appwrite';

/**
 * Atomic Takedown Listing Function using Appwrite Native Transactions
 * 
 * This function handles the complete listing takedown flow atomically:
 * 1. Validates the request
 * 2. Fetches listing details from TicketsForInstantSale
 * 3. Deletes from TicketsForInstantSale collection
 * 4. Deletes from Listings collection
 * 5. Updates original ticket (restores quantity, sets isListedForSale to false)
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

  try {
    // Parse request body
    const {
      ticketId,
      userId
    } = JSON.parse(req.body || '{}');

    log('Starting atomic listing takedown', { 
      ticketId, 
      userId 
    });

    // ============================================
    // STEP 1: Validate inputs
    // ============================================
    if (!ticketId || !userId) {
      error('Missing required fields');
      return res.json({
        success: false,
        error: 'Missing required fields: ticketId and userId',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    // ============================================
    // STEP 2: Create Appwrite Transaction
    // ============================================
    log('Creating Appwrite transaction for listing takedown');
    
    // Create transaction with 5-minute TTL (300 seconds)
    // TTL must be between 60 and 3,600 seconds
    const transaction = await databases.createTransaction(300);
    appwriteTransactionId = transaction.$id;
    
    log('Transaction created successfully', { transactionId: appwriteTransactionId });

    // ============================================
    // STEP 3: Verify ticket exists and belongs to user
    // ============================================
    log('Verifying ticket ownership');
    
    const originalTicketDoc = await databases.getDocument(
      DATABASE_ID,
      'tickets',
      ticketId,
      [],
      appwriteTransactionId
    );

    // Verify ownership
    if (originalTicketDoc.userId !== userId) {
      error('User does not own this ticket');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'You do not have permission to take down this listing',
        code: 'PERMISSION_DENIED'
      }, 403);
    }

    // Verify ticket is actually listed
    if (originalTicketDoc.isListedForSale !== 'true') {
      error('Ticket is not listed for sale');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'Ticket is not currently listed for sale',
        code: 'NOT_LISTED'
      }, 400);
    }

    // ============================================
    // STEP 4: Fetch listing details from TicketsForInstantSale
    // ============================================
    log('Fetching listing details from TicketsForInstantSale');
    
    const instantSaleQuery = await databases.listDocuments(
      DATABASE_ID,
      'TicketsForInstantSale',
      [Query.equal('ticketId', ticketId)],
      undefined,
      appwriteTransactionId
    );

    if (instantSaleQuery.documents.length === 0) {
      error('No instant sale listing found');
      await databases.updateTransaction(appwriteTransactionId, false);
      
      return res.json({
        success: false,
        error: 'No listing found for this ticket',
        code: 'LISTING_NOT_FOUND'
      }, 404);
    }

    const instantSaleDoc = instantSaleQuery.documents[0];
    const listingQuantity = parseInt(instantSaleDoc.quantity) || 0;
    const instantSaleDocId = instantSaleDoc.$id;

    log('Found instant sale listing', { 
      instantSaleDocId, 
      listingQuantity 
    });

    // ============================================
    // STEP 5: Fetch listing from Listings collection
    // ============================================
    log('Fetching listing from Listings collection');
    
    const listingQuery = await databases.listDocuments(
      DATABASE_ID,
      'Listings',
      [Query.equal('ticketId', ticketId)],
      undefined,
      appwriteTransactionId
    );

    const listingDocId = listingQuery.documents.length > 0 
      ? listingQuery.documents[0].$id 
      : null;

    log('Found listing document', { listingDocId });

    // ============================================
    // STEP 6: Delete from TicketsForInstantSale
    // ============================================
    log('Deleting from TicketsForInstantSale collection');
    
    await databases.deleteDocument(
      DATABASE_ID,
      'TicketsForInstantSale',
      instantSaleDocId,
      appwriteTransactionId
    );

    log('Deleted from TicketsForInstantSale successfully');

    // ============================================
    // STEP 7: Delete from Listings collection (if exists)
    // ============================================
    if (listingDocId) {
      log('Deleting from Listings collection');
      
      await databases.deleteDocument(
        DATABASE_ID,
        'Listings',
        listingDocId,
        appwriteTransactionId
      );

      log('Deleted from Listings successfully');
    } else {
      log('No listing found in Listings collection to delete');
    }

    // ============================================
    // STEP 8: Update original ticket
    // ============================================
    log('Updating original ticket');
    
    const currentQuantity = parseInt(originalTicketDoc.quantity) || 0;
    const restoredQuantity = currentQuantity + listingQuantity;

    await databases.updateDocument(
      DATABASE_ID,
      'tickets',
      ticketId,
      {
        isListedForSale: 'false',
        quantity: restoredQuantity.toString(),
        quantityListedForSale: '0'
      },
      [],
      appwriteTransactionId
    );

    log('Original ticket updated successfully', {
      ticketId,
      restoredQuantity,
      previousQuantity: currentQuantity,
      listingQuantity
    });

    // ============================================
    // STEP 9: Commit transaction
    // ============================================
    log('Committing listing takedown transaction', { transactionId: appwriteTransactionId });
    
    await databases.updateTransaction(
      appwriteTransactionId,
      true // true = commit, false = rollback
    );
    
    log('Listing takedown transaction committed successfully');

    // ============================================
    // SUCCESS - Return takedown details
    // ============================================
    log('Listing takedown completed successfully');
    
    return res.json({
      success: true,
      data: {
        ticketId: ticketId,
        restoredQuantity: restoredQuantity.toString(),
        listingQuantity: listingQuantity.toString(),
        message: 'Listing taken down successfully'
      }
    }, 200);

  } catch (err) {
    // ============================================
    // ERROR HANDLING & AUTOMATIC ROLLBACK
    // ============================================
    error('Listing takedown failed', err);
    
    // Appwrite automatically rolls back transactions on error
    // No manual rollback needed
    if (appwriteTransactionId) {
      log('Transaction will be automatically rolled back by Appwrite', { transactionId: appwriteTransactionId });
    }

    // Determine error code and message
    let errorCode = 'TAKEDOWN_ERROR';
    let errorMessage = err.message || 'Listing takedown failed';
    
    if (err.code === 409 || err.message?.includes('conflict')) {
      errorCode = 'CONFLICT_ERROR';
      errorMessage = 'Takedown conflict detected. Please try again.';
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


import { Client, Databases, ID, Query } from 'node-appwrite';

/**
 * Atomic function to list a ticket for sale
 * This function ensures all related operations are atomic:
 * 1. Create entry in TicketsForInstantSale collection
 * 2. Create entry in Listings collection
 * 3. Update original ticket's isListedForSale status and quantity
 * 4. Fetch seller name from users collection
 */
export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const DATABASE_ID = process.env.DATABASE_ID || process.env.APPWRITE_FUNCTION_DATABASE_ID;
  
  let transactionId = null;
  
  try {
    log('Starting atomic ticket listing process');

    // Parse request body
    const requestBody = JSON.parse(req.body);
    const {
      ticketId,
      eventId,
      eventName,
      eventSubName,
      sellerUserId,
      sellingPrice,
      sellingOption,
      listingExpiry,
      customNote,
      eventDate,
      eventVenue,
      eventTime,
      quantity,
      access,
      listingQuantity
    } = requestBody;

    // Validate required fields
    if (!ticketId || !eventId || !sellerUserId || !sellingPrice || !listingQuantity) {
      log('Missing required fields');
      return res.json({
        success: false,
        error: 'Missing required fields: ticketId, eventId, sellerUserId, sellingPrice, listingQuantity',
        code: 'MISSING_FIELDS'
      });
    }

    log('Starting atomic transaction for ticket listing', { ticketId, sellerUserId });

    // Create Appwrite Transaction with 5-minute TTL (300 seconds)
    log('Creating Appwrite transaction');
    // Create transaction with 5-minute TTL (300 seconds)
    // TTL must be between 60 and 3,600 seconds
    const transaction = await databases.createTransaction(300);
    transactionId = transaction.$id;
    
    log('Transaction created successfully', { transactionId });

    try {
      // STEP 1: Fetch seller name from users collection
      log('Fetching seller details');
      const sellerUser = await databases.getDocument(
        DATABASE_ID,
        'users',
        sellerUserId,
        [],
        transactionId
      );
      const sellerName = sellerUser.name || 'Unknown Seller';

      // STEP 2: Create entry in TicketsForInstantSale collection
      log('Creating instant sale ticket entry');
      const instantSaleTicketId = ID.unique();
      const instantSaleTicket = await databases.createDocument(
        DATABASE_ID,
        'TicketsForInstantSale',
        instantSaleTicketId,
        {
          ticketId: ticketId,
          eventId: eventId,
          eventName: eventName,
          eventSubName: eventSubName,
          sellerUserId: sellerUserId,
          sellerName: sellerName,
          sellingPrice: sellingPrice,
          expiry: listingExpiry,
          messageToBuyers: customNote,
          status: 'Available',
          eventDate: eventDate,
          eventVenue: eventVenue,
          eventTime: eventTime,
          quantity: listingQuantity,
          access: access
        },
        [],
        transactionId
      );

      log('Instant sale ticket created', { instantSaleTicketId: instantSaleTicket.$id });

      // STEP 3: Create entry in Listings collection
      log('Creating listing entry');
      const listingId = ID.unique();
      const listing = await databases.createDocument(
        DATABASE_ID,
        'Listings',
        listingId,
        {
          ticketId: ticketId,
          sellerIUserd: sellerUserId, // Note: keeping original field name for compatibility
          sellingPrice: sellingPrice,
          sellingOption: sellingOption,
          listingExpiry: listingExpiry,
          NoteToBuyers: customNote,
          quantity: listingQuantity
        },
        [],
        transactionId
      );

      log('Listing created', { listingId: listing.$id });

      // STEP 4: Update original ticket's isListedForSale status and quantity
      log('Updating original ticket status');
      const newQuantity = (parseInt(quantity) - parseInt(listingQuantity)).toString();
      const updatedTicket = await databases.updateDocument(
        DATABASE_ID,
        'tickets',
        ticketId,
        {
          isListedForSale: 'true',
          quantity: newQuantity,
          quantityListedForSale: listingQuantity
        },
        [],
        transactionId
      );

      log('Original ticket updated', { 
        ticketId: ticketId, 
        newQuantity: newQuantity, 
        quantityListedForSale: listingQuantity 
      });

      // Commit the transaction
      await databases.updateTransaction(transactionId, true); // true = commit
      log('Transaction committed successfully');

      // Return success response
      return res.json({
        success: true,
        data: {
          instantSaleTicketId: instantSaleTicket.$id,
          listingId: listing.$id,
          updatedTicketId: updatedTicket.$id,
          sellerName: sellerName,
          newQuantity: newQuantity,
          quantityListedForSale: listingQuantity,
          message: 'Ticket listed for sale successfully'
        }
      });

    } catch (transactionError) {
      // Rollback the transaction
      try {
        await databases.updateTransaction(transactionId, false); // false = rollback
        log('Transaction rolled back due to error', { error: transactionError.message });
      } catch (rollbackErr) {
        log('Transaction rollback failed', { rollbackError: rollbackErr.message });
      }
      throw transactionError;
    }

  } catch (err) {
    // ============================================
    // ERROR HANDLING & AUTOMATIC ROLLBACK
    // ============================================
    error('Ticket listing failed, rolling back transaction', err);
    
    // Attempt to rollback the transaction if it was created
    if (transactionId) {
      try {
        log('Rolling back transaction', { transactionId });
        
        await databases.updateTransaction(
          transactionId,
          false // true = commit, false = rollback
        );
        
        log('Transaction rolled back successfully - no data persisted');
      } catch (rollbackErr) {
        error('Transaction rollback failed', {
          rollbackError: rollbackErr.message,
          originalError: err.message,
          transactionId: transactionId
        });
        // Even if rollback fails, Appwrite will auto-rollback uncommitted transactions
      }
    } else {
      log('No transaction to rollback - error occurred before transaction creation');
    }
    
    // Determine error code and message
    let errorCode = 'LISTING_ERROR';
    let errorMessage = err.message || 'Ticket listing failed';
    
    // Check for specific Appwrite error types
    if (err.code === 409 || err.message?.includes('conflict')) {
      errorCode = 'CONFLICT_ERROR';
      errorMessage = 'Listing conflict detected. Please try again.';
    } else if (err.message?.includes('not found')) {
      errorCode = 'NOT_FOUND_ERROR';
      errorMessage = 'Ticket or event not found';
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
      transactionRolledBack: transactionId !== null
    }, 500);
  }
};



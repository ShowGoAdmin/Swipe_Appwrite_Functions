import { Client, Databases, ID, Query } from 'node-appwrite';

const client = new Client()
  .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

/**
 * Atomic function to list a ticket for sale
 * This function ensures all related operations are atomic:
 * 1. Create entry in TicketsForInstantSale collection
 * 2. Create entry in Listings collection
 * 3. Update original ticket's isListedForSale status and quantity
 * 4. Fetch seller name from users collection
 */
export default async ({ req, res, log }) => {
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

    // Start atomic transaction
    const transaction = await databases.beginTransaction();

    try {
      // STEP 1: Fetch seller name from users collection
      log('Fetching seller details');
      const sellerUser = await databases.getDocument(
        process.env.APPWRITE_FUNCTION_DATABASE_ID,
        'users',
        sellerUserId
      );
      const sellerName = sellerUser.name || 'Unknown Seller';

      // STEP 2: Create entry in TicketsForInstantSale collection
      log('Creating instant sale ticket entry');
      const instantSaleTicketId = ID.unique();
      const instantSaleTicket = await databases.createDocument(
        process.env.APPWRITE_FUNCTION_DATABASE_ID,
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
        }
      );

      log('Instant sale ticket created', { instantSaleTicketId: instantSaleTicket.$id });

      // STEP 3: Create entry in Listings collection
      log('Creating listing entry');
      const listingId = ID.unique();
      const listing = await databases.createDocument(
        process.env.APPWRITE_FUNCTION_DATABASE_ID,
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
        }
      );

      log('Listing created', { listingId: listing.$id });

      // STEP 4: Update original ticket's isListedForSale status and quantity
      log('Updating original ticket status');
      const newQuantity = (parseInt(quantity) - parseInt(listingQuantity)).toString();
      const updatedTicket = await databases.updateDocument(
        process.env.APPWRITE_FUNCTION_DATABASE_ID,
        'tickets',
        ticketId,
        {
          isListedForSale: 'true',
          quantity: newQuantity,
          quantityListedForSale: listingQuantity
        }
      );

      log('Original ticket updated', { 
        ticketId: ticketId, 
        newQuantity: newQuantity, 
        quantityListedForSale: listingQuantity 
      });

      // Commit the transaction
      await databases.commitTransaction(transaction);
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
      await databases.rollbackTransaction(transaction);
      log('Transaction rolled back due to error', { error: transactionError.message });
      throw transactionError;
    }

  } catch (error) {
    log('Error in atomic ticket listing', { error: error.message });
    return res.json({
      success: false,
      error: error.message || 'Unknown error occurred',
      code: 'LISTING_ERROR'
    });
  }
};

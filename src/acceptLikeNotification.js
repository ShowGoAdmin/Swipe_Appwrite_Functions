import { Client, Databases } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  log('=== FUNCTION STARTED ===');
  
  try {
    log('Step 1: Parsing request body');
    log(`Request body: ${req.body}`);
    
    // Parse request body
    const { groupId, accepterUserId } = JSON.parse(req.body);
    
    log(`Step 2: Received groupId: ${groupId}, accepterUserId: ${accepterUserId}`);

    if (!groupId || !accepterUserId) {
      log('ERROR: Missing required parameters');
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: groupId, accepterUserId' 
      });
    }

    if (!process.env.DATABASE_ID) {
      log('ERROR: DATABASE_ID environment variable is not set');
      return res.json({
        success: false,
        message: 'Database ID not configured'
      });
    }

    log(`Step 3: Using DATABASE_ID: ${process.env.DATABASE_ID}`);
    
    // Initialize Appwrite client
    log('Step 4: Initializing Appwrite client');
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);
    log('Step 5: Appwrite client initialized');

    // Get the group document
    log(`Step 6: Fetching group document with ID: ${groupId}`);
    const group = await databases.getDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId
    );
    log(`Step 7: Group fetched - isDirectChat: ${group.isDirectChat}, isAccepted: ${group.isAccepted}`);

    // Verify this is a direct chat with pending like
    if (!group.isDirectChat || group.isAccepted) {
      log('ERROR: Not a pending like notification');
      return res.json({
        success: false,
        message: 'This is not a pending like notification'
      });
    }
    
    log('Step 8: Group verified as pending like notification');
    
    // Update the group to convert it to an accepted direct chat
    log('Step 9: Updating group document to accepted state');
    await databases.updateDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId,
      {
        isAccepted: true,
        groupName: `Match: ${group.eventname}`,
        groupDescription: `You matched at ${group.eventname}!`,
        likerUserId: null
      }
    );

    log(`Step 10: Group updated successfully - ${groupId}`);
    log('Step 11: Sending success response');

    return res.json({
      success: true,
      isMatch: true,
      chatId: groupId,
      message: 'Match accepted! You can now chat.'
    });

  } catch (err) {
    error(`=== ERROR CAUGHT === ${err.message}`);
    error(`Error stack: ${err.stack}`);
    return res.json({
      success: false,
      message: 'Internal server error',
      error: err.message
    });
  }
};


import { Client, Databases } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    log('Accept like function started');
    
    // Parse request body - handle both string and object
    let requestData;
    try {
      requestData = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      log(`Body parse error: ${parseError.message}`);
      return res.send(JSON.stringify({ 
        success: false, 
        message: 'Invalid request body' 
      }), 400);
    }

    const { groupId, accepterUserId } = requestData;

    if (!groupId || !accepterUserId) {
      log('Missing parameters');
      return res.send(JSON.stringify({ 
        success: false, 
        message: 'Missing required parameters: groupId, accepterUserId' 
      }), 400);
    }

    if (!process.env.DATABASE_ID) {
      log('DATABASE_ID not configured');
      return res.send(JSON.stringify({
        success: false,
        message: 'Database ID not configured'
      }), 500);
    }

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);

    log(`Fetching group: ${groupId}`);

    // Get the group document
    const group = await databases.getDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId
    );

    // Verify this is a direct chat with pending like
    if (!group.isDirectChat || group.isAccepted) {
      log('Not a pending like');
      return res.send(JSON.stringify({
        success: false,
        message: 'This is not a pending like notification'
      }), 400);
    }

    log('Updating group to accepted');

    // Update the group to convert it to an accepted direct chat
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

    log(`Like accepted: ${groupId}`);

    return res.send(JSON.stringify({
      success: true,
      isMatch: true,
      chatId: groupId,
      message: 'Match accepted! You can now chat.'
    }), 200);

  } catch (err) {
    error(`Error: ${err.message}`);
    return res.send(JSON.stringify({
      success: false,
      message: 'Internal server error',
      error: err.message
    }), 500);
  }
};


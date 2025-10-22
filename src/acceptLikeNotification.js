import { Client, Databases } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);

    // Parse request body
    const { groupId, accepterUserId } = JSON.parse(req.body);

    if (!groupId || !accepterUserId) {
      log('Missing required parameters');
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: groupId, accepterUserId' 
      }, 400);
    }

    if (!process.env.DATABASE_ID) {
      log('DATABASE_ID not configured');
      return res.json({
        success: false,
        message: 'Database ID not configured'
      }, 500);
    }

    // Get the group document
    const group = await databases.getDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId
    );

    // Verify this is a direct chat with pending like
    if (!group.isDirectChat || group.isAccepted) {
      log('Invalid like notification state');
      return res.json({
        success: false,
        message: 'This is not a pending like notification'
      }, 400);
    }

    // Update the group to convert it to an accepted direct chat
    await databases.updateDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId,
      {
        isAccepted: true,
        groupName: `Match: ${group.eventname}`,
        groupDescription: `You matched at ${group.eventname}!`,
        likerUserId: null  // Clear likerUserId after acceptance
      }
    );

    log(`Like accepted for group ${groupId}`);

    return res.json({
      success: true,
      isMatch: true,
      chatId: groupId,
      message: 'Match accepted! You can now chat.'
    }, 200);

  } catch (err) {
    error(`Error: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error',
      error: err.message
    }, 500);
  }
};


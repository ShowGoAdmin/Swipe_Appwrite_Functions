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
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: groupId, accepterUserId' 
      });
    }

    if (!process.env.DATABASE_ID) {
      log('DATABASE_ID environment variable is not set');
      return res.json({
        success: false,
        message: 'Database ID not configured'
      });
    }

    // Get the group document
    const group = await databases.getDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId
    );

    log('1. verifying group document');
    // Verify this is a direct chat with pending like
    if (!group.isDirectChat || group.isAccepted) {
      return res.json({
        success: false,
        message: 'This is not a pending like notification'
      });
    }
    log('2. verified group document');
    // Update the group to convert it to an accepted direct chat
    log('3. updating group document');
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

    log('4. updated group document');
    log(`5. Like accepted for group ${groupId}`);

    return res.json({
      success: true,
      isMatch: true,
      chatId: groupId,
      message: 'Match accepted! You can now chat.'
    });

    log('6. returned response');
  } catch (err) {
    error(`Error accepting like notification: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error',
      error: err.message
    });
  }
};


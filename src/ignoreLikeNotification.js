import { Client, Databases, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);

    // Parse request body
    const { groupId, userId } = JSON.parse(req.body);

    if (!groupId || !userId) {
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: groupId, userId' 
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

    // Verify this is a direct chat with pending like
    if (!group.isDirectChat || group.isAccepted) {
      return res.json({
        success: false,
        message: 'This is not a pending like notification'
      });
    }

    // Delete the group document
    await databases.deleteDocument(
      process.env.DATABASE_ID,
      'groups',
      groupId
    );

    // Also delete any associated messages
    const messages = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.MESSAGES_COLLECTION_ID || 'chatMessages',
      [Query.equal('groupsId', groupId)]
    );

    // Delete all messages in this group
    for (const message of messages.documents) {
      await databases.deleteDocument(
        process.env.DATABASE_ID,
        process.env.MESSAGES_COLLECTION_ID || 'chatMessages',
        message.$id
      );
    }

    log(`Like notification ignored. Group ${groupId} and associated messages deleted`);

    return res.json({
      success: true,
      message: 'Like notification ignored and deleted'
    });

  } catch (err) {
    error(`Error ignoring like notification: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error',
      error: err.message
    });
  }
};


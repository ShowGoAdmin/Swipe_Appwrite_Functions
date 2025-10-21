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
    const { likerUserId, likedUserId, eventId } = JSON.parse(req.body);

    if (!likerUserId || !likedUserId || !eventId) {
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: likerUserId, likedUserId, eventId' 
      });
    }

    if (!process.env.DATABASE_ID) {
      log('DATABASE_ID environment variable is not set');
      return res.json({
        success: false,
        message: 'Database ID not configured'
      });
    }

    if (!process.env.MESSAGES_COLLECTION_ID) {
      log('MESSAGES_COLLECTION_ID environment variable is not set');
      return res.json({
        success: false,
        message: 'Messages collection ID not configured'
      });
    }

    // Get liker and event details
    const [liker, event] = await Promise.all([
      databases.getDocument(process.env.DATABASE_ID, 'users', likerUserId),
      databases.getDocument(process.env.DATABASE_ID, 'events', eventId)
    ]);

    // Get the current timestamp in milliseconds and format it
    const currentTimestampMillis = Date.now();
    const formattedTimestamp = new Date(currentTimestampMillis).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    // Create notification message (matching Appwrite schema)
    const notificationMessage = {
      groupsId: likedUserId, // Use liked user's ID as group ID for personal notifications
      senderId: 'system',
      senderName: 'ShowGo',
      textMessage: `👋 ${liker.name} liked you! You both are attending ${event.name}. Would you like to get along?`,
      timestamp: formattedTimestamp,
      profilePicUrl: liker.profilePicUrl || ''
    };

    // Store notification in messages collection
    await databases.createDocument(
      process.env.DATABASE_ID,
      process.env.MESSAGES_COLLECTION_ID,
      'unique()',
      notificationMessage
    );

    log(`Like notification sent to user: ${likedUserId}`);

    return res.json({
      success: true,
      message: 'Like notification sent successfully',
      likerName: liker.name,
      eventName: event.name
    });

  } catch (err) {
    error(`Error sending like notification: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error',
      error: err.message
    });
  }
};

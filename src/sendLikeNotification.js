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
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters: likerUserId, likedUserId, eventId' 
      });
    }

    // Get liker and event details
    const [liker, event] = await Promise.all([
      databases.getDocument(process.env.DATABASE_ID, 'users', likerUserId),
      databases.getDocument(process.env.DATABASE_ID, 'events', eventId)
    ]);

    // Create notification message
    const notificationMessage = {
      groupId: likedUserId, // Use liked user's ID as group ID for personal notifications
      senderId: 'system',
      senderName: 'ShowGo',
      messageText: `👋 ${liker.name} liked you! You both are attending ${event.name}. Would you like to get along?`,
      timestamp: new Date().toISOString(),
      isSystemMessage: true,
      isLikeNotification: true,
      likerUserId,
      eventId,
      eventName: event.name
    };

    // Store notification in messages collection
    await databases.createDocument(
      process.env.DATABASE_ID,
      'chatMessages',
      'unique()',
      notificationMessage
    );

    log(`Like notification sent to user: ${likedUserId}`);

    return res.json({
      success: true,
      message: 'Like notification sent successfully'
    });

  } catch (err) {
    error(`Error sending like notification: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

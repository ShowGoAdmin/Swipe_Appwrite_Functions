import { Client, Databases, Functions } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);
    const functions = new Functions(client);

    // Parse request body
    const { likerUserId, likedUserId, eventId } = JSON.parse(req.body);

    if (!likerUserId || !likedUserId || !eventId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters: likerUserId, likedUserId, eventId' 
      });
    }

    // Check if like already exists
    const existingLikes = await databases.listDocuments(
      process.env.DATABASE_ID,
      'attendeeLikes',
      [
        `likerUserId=${likerUserId}`,
        `likedUserId=${likedUserId}`,
        `eventId=${eventId}`
      ]
    );

    if (existingLikes.total > 0) {
      return res.json({ 
        success: false, 
        message: 'Like already exists' 
      });
    }

    // Create the like record
    const likeRecord = await databases.createDocument(
      process.env.DATABASE_ID,
      'attendeeLikes',
      'unique()',
      {
        likerUserId,
        likedUserId,
        eventId,
        timestamp: new Date().toISOString(),
        isActive: true
      }
    );

    log(`Like created: ${likeRecord.$id}`);

    // Check for mutual like (match)
    const mutualLike = await databases.listDocuments(
      process.env.DATABASE_ID,
      'attendeeLikes',
      [
        `likerUserId=${likedUserId}`,
        `likedUserId=${likerUserId}`,
        `eventId=${eventId}`
      ]
    );

    if (mutualLike.total > 0) {
      // It's a match! Create match record and chat
      log('Mutual like detected - creating match');
      
      // Call the createMatch function
      const matchResult = await functions.createExecution(
        'createAttendeeMatch',
        JSON.stringify({
          user1Id: likerUserId,
          user2Id: likedUserId,
          eventId
        })
      );

      return res.json({
        success: true,
        isMatch: true,
        matchId: matchResult.response,
        message: 'It\'s a match!'
      });
    } else {
      // Send notification to the liked user
      log('Sending like notification');
      
      // Call notification function
      await functions.createExecution(
        'sendLikeNotification',
        JSON.stringify({
          likerUserId,
          likedUserId,
          eventId
        })
      );

      return res.json({
        success: true,
        isMatch: false,
        message: 'Like sent successfully'
      });
    }

  } catch (err) {
    error(`Error handling attendee like: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

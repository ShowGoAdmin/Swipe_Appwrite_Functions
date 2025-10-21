import { Client, Databases, Functions, Query } from 'node-appwrite';

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
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: likerUserId, likedUserId, eventId' 
      });
    }

    // Check if DATABASE_ID is set
    if (!process.env.DATABASE_ID) {
      log('DATABASE_ID environment variable is not set');
      return res.json({
        success: false,
        message: 'Database ID not configured'
      });
    }

    log(`Using DATABASE_ID: ${process.env.DATABASE_ID}`);

    // Check if like already exists
    const existingLikes = await databases.listDocuments(
      process.env.DATABASE_ID,
      'attendeeLikes',
      [
        Query.equal('likerUserId', likerUserId),
        Query.equal('likedUserId', likedUserId),
        Query.equal('eventId', eventId)
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
        Query.equal('likerUserId', likedUserId),
        Query.equal('likedUserId', likerUserId),
        Query.equal('eventId', eventId)
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

      const matchData = JSON.parse(matchResult.responseBody || '{}');

      return res.json({
        success: true,
        isMatch: true,
        matchId: matchData.matchId || '',
        chatId: matchData.chatId || '',
        message: 'It\'s a match!'
      });
    } else {
      // Create a like notification group (chat-like interface)
      log('Creating like notification group');
      
      // Get event and user details
      const [event, liker] = await Promise.all([
        databases.getDocument(process.env.DATABASE_ID, 'events', eventId),
        databases.getDocument(process.env.DATABASE_ID, 'users', likerUserId)
      ]);

      // Create a direct chat group with pending like
      const notificationGroup = await databases.createDocument(
        process.env.DATABASE_ID,
        'groups',
        'unique()',
        {
          groupName: `Like from ${liker.name}`,
          groupDescription: `${liker.name} wants to connect with you for ${event.name}`,
          eventId: eventId,
          eventname: event.name,
          members: `${likerUserId},${likedUserId}`, // Both users are members
          adminUserId: likerUserId,
          eventDate: event.date || '',
          eventLocation: event.location || '',
          groupImageId: liker.profilePicUrl || '',
          eventLocation_Lat_Lng_VenueName: event.eventLocation_Lat_Lng_VenueName || '',
          isDirectChat: true,  // Mark as direct chat
          matchId: likeRecord.$id,  // Store the like record ID as matchId
          likerUserId: likerUserId,  // Who sent the like
          isAccepted: false  // Pending acceptance
        }
      );

      log(`Like notification group created: ${notificationGroup.$id}`);

      return res.json({
        success: true,
        isMatch: false,
        groupId: notificationGroup.$id,
        message: 'Like sent successfully'
      });
    }

  } catch (err) {
    error(`Error handling attendee like: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error'
    });
  }
};

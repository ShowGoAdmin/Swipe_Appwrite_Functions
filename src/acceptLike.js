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
    const { accepterUserId, likerUserId, eventId } = JSON.parse(req.body);

    if (!accepterUserId || !likerUserId || !eventId) {
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: accepterUserId, likerUserId, eventId' 
      });
    }

    // Check if mutual like exists
    const mutualLike = await databases.listDocuments(
      process.env.DATABASE_ID,
      'attendeeLikes',
      [
        Query.equal('likerUserId', accepterUserId),
        Query.equal('likedUserId', likerUserId),
        Query.equal('eventId', eventId)
      ]
    );

    if (mutualLike.total === 0) {
      // Create the like from accepter to liker
      await databases.createDocument(
        process.env.DATABASE_ID,
        'attendeeLikes',
        'unique()',
        {
          likerUserId: accepterUserId,
          likedUserId: likerUserId,
          eventId,
          timestamp: new Date().toISOString(),
          isActive: true
        }
      );
    }

    // Now create the match
    const matchResult = await functions.createExecution(
      'createAttendeeMatch',
      JSON.stringify({
        user1Id: accepterUserId,
        user2Id: likerUserId,
        eventId
      })
    );

    log(`Like accepted and match created: ${matchResult.response}`);

    return res.json({
      success: true,
      isMatch: true,
      matchId: matchResult.response,
      message: 'Like accepted! It\'s a match!'
    });

  } catch (err) {
    error(`Error accepting like: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error'
    });
  }
};

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
    const { eventId, currentUserId } = JSON.parse(req.body);

    if (!eventId || !currentUserId) {
      return res.json({ 
        success: false, 
        message: 'Missing required parameters: eventId, currentUserId' 
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

    // Get all tickets for this event
    const tickets = await databases.listDocuments(
      process.env.DATABASE_ID,
      'tickets',
      [
        Query.equal('eventId', eventId)
      ]
    );

    // Get unique user IDs from tickets
    const userIds = [...new Set(tickets.documents.map(ticket => ticket.userId))];
    
    // Remove current user from the list
    const otherUserIds = userIds.filter(id => id !== currentUserId);

    if (otherUserIds.length === 0) {
      return res.json({
        success: true,
        attendees: [],
        message: 'No other attendees found'
      });
    }

    // Get user details for attendees
    const attendees = [];
    for (const userId of otherUserIds) {
      try {
        const user = await databases.getDocument(
          process.env.DATABASE_ID,
          'users',
          userId
        );

        // Check if user has already been liked by current user
        let existingLike = { total: 0 };
        try {
          existingLike = await databases.listDocuments(
            process.env.DATABASE_ID,
            'attendeeLikes',
            [
              Query.equal('likerUserId', currentUserId),
              Query.equal('likedUserId', userId),
              Query.equal('eventId', eventId)
            ]
          );
        } catch (likeError) {
          log(`Error checking existing likes: ${likeError.message}`);
          // Continue without checking likes if collection doesn't exist
        }

        if (existingLike.total === 0) {
          attendees.push({
            id: `attendee_${userId}_${eventId}`,
            userId: user.$id,
            eventId,
            name: user.name,
            profilePicUrl: user.profilePicUrl || '',
            musicInterests: user.musicInterests || [],
            bio: user.bio || '',
            age: user.age || null,
            isActive: true,
            createdAt: user.$createdAt
          });
        }
      } catch (userError) {
        log(`Error fetching user ${userId}: ${userError.message}`);
        // Continue with other users
      }
    }

    log(`Found ${attendees.length} attendees for event ${eventId}`);

    return res.json({
      success: true,
      attendees,
      message: `Found ${attendees.length} attendees`
    });

  } catch (err) {
    error(`Error getting event attendees: ${err.message}`);
    return res.json({
      success: false,
      message: 'Internal server error'
    });
  }
};

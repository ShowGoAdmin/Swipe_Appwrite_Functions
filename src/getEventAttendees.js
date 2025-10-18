import { Client, Databases, Query } from 'node-appwrite';

export default async ({ req, log, error }) => {
  try {
    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

    const databases = new Databases(client);

    // Parse payload
    const { eventId, currentUserId } = JSON.parse(req.payload || '{}');

    if (!eventId || !currentUserId) {
      return {
        success: false,
        message: 'Missing required parameters: eventId, currentUserId'
      };
    }

    const databaseId = process.env.DATABASE_ID;
    if (!databaseId) {
      return {
        success: false,
        message: 'Missing DATABASE_ID environment variable'
      };
    }

    // Get all active tickets for this event
    const tickets = await databases.listDocuments(
      databaseId,
      'tickets',
      [
        Query.equal('eventId', eventId),
        Query.equal('isActive', true)
      ]
    );

    const userIds = [...new Set(tickets.documents.map(ticket => ticket.userId))];
    const otherUserIds = userIds.filter(id => id !== currentUserId);

    if (otherUserIds.length === 0) {
      return {
        success: true,
        attendees: [],
        message: 'No other attendees found'
      };
    }

    const attendees = [];
    for (const userId of otherUserIds) {
      try {
        const user = await databases.getDocument(databaseId, 'users', userId);

        // Check if user has already been liked by current user
        const existingLike = await databases.listDocuments(
          databaseId,
          'attendeeLikes',
          [
            Query.equal('likerUserId', currentUserId),
            Query.equal('likedUserId', userId),
            Query.equal('eventId', eventId)
          ]
        );

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
      }
    }

    log(`Found ${attendees.length} attendees for event ${eventId}`);

    return {
      success: true,
      attendees,
      message: `Found ${attendees.length} attendees`
    };

  } catch (err) {
    error(`Error getting event attendees: ${err.message}`);
    return {
      success: false,
      message: 'Internal server error'
    };
  }
};

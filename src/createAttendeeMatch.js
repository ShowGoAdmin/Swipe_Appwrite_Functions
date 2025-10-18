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
    const { user1Id, user2Id, eventId } = JSON.parse(req.body);

    if (!user1Id || !user2Id || !eventId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters: user1Id, user2Id, eventId' 
      });
    }

    // Get event name
    const event = await databases.getDocument(
      process.env.DATABASE_ID,
      'events',
      eventId
    );

    // Create match record
    const matchRecord = await databases.createDocument(
      process.env.DATABASE_ID,
      'attendeeMatches',
      'unique()',
      {
        user1Id,
        user2Id,
        eventId,
        eventName: event.name,
        matchTimestamp: new Date().toISOString(),
        isActive: true
      }
    );

    // Create a direct chat for the matched users
    const chatRecord = await databases.createDocument(
      process.env.DATABASE_ID,
      'groups',
      'unique()',
      {
        groupName: `Match: ${event.name}`,
        groupDescription: `Direct chat between matched attendees`,
        eventId,
        eventname: event.name,
        members: [user1Id, user2Id],
        adminUserId: user1Id,
        eventDate: event.date,
        eventLocation: event.location,
        groupImageId: '',
        eventLocation_Lat_Lng_VenueName: `${event.latitude}:${event.longitude}:${event.venue}`,
        isDirectChat: true,
        matchId: matchRecord.$id
      }
    );

    // Update match record with chat ID
    await databases.updateDocument(
      process.env.DATABASE_ID,
      'attendeeMatches',
      matchRecord.$id,
      {
        chatId: chatRecord.$id
      }
    );

    // Send match notification to both users
    const matchMessage = {
      groupId: chatRecord.$id,
      senderId: 'system',
      senderName: 'ShowGo',
      messageText: `🎉 You both liked each other! You're both attending ${event.name}. Start chatting!`,
      timestamp: new Date().toISOString(),
      isSystemMessage: true
    };

    await databases.createDocument(
      process.env.DATABASE_ID,
      'chatMessages',
      'unique()',
      matchMessage
    );

    log(`Match created: ${matchRecord.$id} with chat: ${chatRecord.$id}`);

    return res.json({
      success: true,
      matchId: matchRecord.$id,
      chatId: chatRecord.$id,
      message: 'Match created successfully'
    });

  } catch (err) {
    error(`Error creating attendee match: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

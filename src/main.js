import { Client, Databases, Users } from 'node-appwrite';
import { messaging } from 'firebase-admin'; // Firebase Admin SDK for notifications

export default async ({ req, res, log, error }) => {
  // Initialize Appwrite client
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

  const databases = new Databases(client);
  const users = new Users(client);

  try {
    // Extract event payload
    const { databaseId, collectionId, documentId } = req.body;

    // Ensure this event is for the correct collection
    if (collectionId !== process.env.MESSAGES_COLLECTION_ID) {
      log(`Ignored event for collection: ${collectionId}`);
      return res.json({ success: false, message: 'Not relevant to messages collection' });
    }

    // Fetch the created document
    const message = await databases.getDocument(databaseId, collectionId, documentId);
    log(`New message: ${JSON.stringify(message)}`);

    const recipientId = message.recipientId;
    const senderId = message.senderId;
    const content = message.content;

    // Fetch the recipient's FCM token from user data
    const recipient = await users.get(recipientId);
    const fcmToken = recipient.fcmToken; // Ensure this field exists in your user model

    if (!fcmToken) {
      log(`No FCM token for user: ${recipientId}`);
      return res.json({ success: false, message: 'Recipient has no FCM token' });
    }

    // Send push notification via Firebase Admin SDK
    const notificationPayload = {
      token: fcmToken,
      notification: {
        title: "New Message Received",
        body: content,
      },
    };

    await messaging().send(notificationPayload);

    log(`Notification sent to user: ${recipientId}`);
    return res.json({ success: true, message: 'Notification sent successfully' });

  } catch (err) {
    error(`Error: ${err.message}`);
    return res.json({ success: false, message: err.message });
  }
};

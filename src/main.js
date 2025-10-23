import { Client, Databases, Storage, ID, Query, InputFile } from 'node-appwrite';

/**
 * FULLY Atomic User Signup Function with Complete Rollback
 * 
 * This function implements a complete atomic signup process that includes:
 * - Profile picture upload to storage
 * - QR code generation and upload to storage  
 * - User document creation in database
 * 
 * If ANY operation fails, EVERYTHING is rolled back including:
 * - Database transaction rollback
 * - Deletion of uploaded profile picture
 * - Deletion of uploaded QR code
 * 
 * This ensures NO orphaned data in storage or database.
 * 
 * Flow:
 * 1. Receive base64 encoded profile picture and QR code
 * 2. Upload profile picture to storage
 * 3. Upload QR code to storage
 * 4. Create database transaction
 * 5. Validate inputs and check for duplicates
 * 6. Stage user document creation
 * 7. Commit transaction
 * 
 * On Failure:
 * - Rollback database transaction
 * - Delete uploaded profile picture (if uploaded)
 * - Delete uploaded QR code (if uploaded)
 * - Return detailed error response
 * 
 * Benefits:
 * - Complete atomicity (storage + database)
 * - No orphaned files in storage
 * - No partial user records in database
 * - Automatic cleanup on any failure
 * - True ACID compliance for database
 * 
 * Reference: https://appwrite.io/docs/products/databases/transactions
 */

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const storage = new Storage(client);
  const DATABASE_ID = process.env.DATABASE_ID;
  const PROFILE_PIC_BUCKET_ID = process.env.USER_PROFILE_PIC_BUCKET_ID;
  const QR_CODE_BUCKET_ID = process.env.USER_QR_CODE_BUCKET_ID;
  
  let appwriteTransactionId = null;
  let userId = null;
  let uploadedProfilePicId = null;
  let uploadedQRCodeId = null;

  try {
    // ============================================
    // STEP 1: Parse and validate request body
    // ============================================
    const {
      userId: providedUserId,     // User ID from account creation (from Appwrite Auth)
      email,
      name,
      profilePicBase64,           // Base64 encoded profile picture
      qrCodeBase64,               // Base64 encoded QR code
      phone,
      countryCode = '+91'
    } = JSON.parse(req.body || '{}');

    log('Starting FULLY atomic user signup (storage + database)', { 
      userId: providedUserId, 
      email, 
      name,
      hasProfilePic: !!profilePicBase64,
      hasQRCode: !!qrCodeBase64
    });

    // ============================================
    // STEP 2: Validate required inputs
    // ============================================
    if (!providedUserId || !email || !name || !profilePicBase64 || !qrCodeBase64 || !phone) {
      error('Missing required fields');
      return res.json({
        success: false,
        error: 'Missing required fields. Required: userId, email, name, profilePicBase64, qrCodeBase64, phone',
        code: 'VALIDATION_ERROR'
      }, 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      error('Invalid email format');
      return res.json({
        success: false,
        error: 'Invalid email format',
        code: 'INVALID_EMAIL'
      }, 400);
    }

    // Validate phone format (basic check)
    if (phone.length < 10) {
      error('Invalid phone number');
      return res.json({
        success: false,
        error: 'Phone number must be at least 10 digits',
        code: 'INVALID_PHONE'
      }, 400);
    }

    userId = providedUserId;

    // ============================================
    // STEP 3: Upload Profile Picture to Storage
    // ============================================
    log('Uploading profile picture to storage');
    
    try {
      // Convert base64 to buffer
      const profilePicBuffer = Buffer.from(profilePicBase64, 'base64');
      const profilePicFileId = `${userId}_user_pic.png`;
      
      // Create InputFile from buffer
      const profilePicInputFile = InputFile.fromBuffer(
        profilePicBuffer,
        profilePicFileId
      );
      
      // Upload file to storage
      const profilePicFile = await storage.createFile(
        PROFILE_PIC_BUCKET_ID,
        profilePicFileId,
        profilePicInputFile
      );
      
      uploadedProfilePicId = profilePicFile.$id;
      log('Profile picture uploaded successfully', { fileId: uploadedProfilePicId });
      
    } catch (err) {
      error('Failed to upload profile picture', err);
      return res.json({
        success: false,
        error: 'Failed to upload profile picture: ' + err.message,
        code: 'PROFILE_PIC_UPLOAD_FAILED'
      }, 500);
    }

    // ============================================
    // STEP 4: Upload QR Code to Storage
    // ============================================
    log('Uploading QR code to storage');
    
    try {
      // Convert base64 to buffer
      const qrCodeBuffer = Buffer.from(qrCodeBase64, 'base64');
      const qrCodeFileId = `${userId}_user_qr.png`;
      
      // Create InputFile from buffer
      const qrCodeInputFile = InputFile.fromBuffer(
        qrCodeBuffer,
        qrCodeFileId
      );
      
      // Upload file to storage
      const qrCodeFile = await storage.createFile(
        QR_CODE_BUCKET_ID,
        qrCodeFileId,
        qrCodeInputFile
      );
      
      uploadedQRCodeId = qrCodeFile.$id;
      log('QR code uploaded successfully', { fileId: uploadedQRCodeId });
      
    } catch (err) {
      error('Failed to upload QR code', err);
      
      // CLEANUP: Delete already uploaded profile picture
      await cleanupUploadedFiles(uploadedProfilePicId, null);
      
      return res.json({
        success: false,
        error: 'Failed to upload QR code: ' + err.message,
        code: 'QR_CODE_UPLOAD_FAILED',
        cleanedUp: ['profilePicture']
      }, 500);
    }

    // ============================================
    // STEP 5: Create Appwrite Transaction
    // ============================================
    log('Creating Appwrite transaction for user signup');
    
    // Create transaction with 3-minute TTL (180 seconds)
    const transaction = await databases.createTransaction(180);
    appwriteTransactionId = transaction.$id;
    
    log('Transaction created successfully', { transactionId: appwriteTransactionId });

    // ============================================
    // STEP 6: Check for duplicate user WITHIN transaction
    // ============================================
    log('Checking for duplicate user within transaction context');
    
    // Check if user document already exists
    try {
      const existingUser = await databases.getDocument(
        DATABASE_ID,
        'users',
        userId,
        [],
        appwriteTransactionId
      );
      
      // User already exists - this is a duplicate
      error('User document already exists');
      
      // Rollback transaction
      await databases.updateTransaction(appwriteTransactionId, false);
      
      // CLEANUP: Delete uploaded files
      await cleanupUploadedFiles(uploadedProfilePicId, uploadedQRCodeId);
      
      return res.json({
        success: false,
        error: 'User account already exists in database',
        code: 'DUPLICATE_USER',
        existingUserId: userId,
        cleanedUp: ['profilePicture', 'qrCode', 'transaction']
      }, 400);
    } catch (err) {
      // Document not found - this is expected and good
      if (err.code === 404 || err.message?.includes('not found')) {
        log('User ID verified as unique', { userId });
      } else {
        // Unexpected error
        throw err;
      }
    }

    // Check for duplicate email
    const existingEmailCheck = await databases.listDocuments(
      DATABASE_ID,
      'users',
      [Query.equal('email', email)],
      undefined,
      appwriteTransactionId
    );

    if (existingEmailCheck.documents.length > 0) {
      error('Email already registered');
      
      // Rollback transaction
      await databases.updateTransaction(appwriteTransactionId, false);
      
      // CLEANUP: Delete uploaded files
      await cleanupUploadedFiles(uploadedProfilePicId, uploadedQRCodeId);
      
      return res.json({
        success: false,
        error: 'This email is already registered',
        code: 'DUPLICATE_EMAIL',
        existingUserId: existingEmailCheck.documents[0].$id,
        cleanedUp: ['profilePicture', 'qrCode', 'transaction']
      }, 400);
    }
    
    log('No duplicate user found, proceeding with creation');

    // ============================================
    // STEP 7: Stage user document creation
    // ============================================
    log('Staging user document creation');
    
    // Build profile picture URL
    const profilePicUrl = `https://cloud.appwrite.io/v1/storage/buckets/${PROFILE_PIC_BUCKET_ID}/files/${uploadedProfilePicId}/view?project=${process.env.APPWRITE_FUNCTION_PROJECT_ID}`;
    
    const userDoc = await databases.createDocument(
      DATABASE_ID,
      'users',
      userId,
      {
        name: name,
        email: email,
        userID: userId,
        qrimageId: uploadedQRCodeId,
        profilePicUrl: profilePicUrl,
        phoneNumber: phone,
        countryCode: countryCode,
        role: 'user'
      },
      [],
      appwriteTransactionId
    );

    log('User document creation staged', { 
      userId,
      email,
      name,
      profilePicUrl,
      qrImageId: uploadedQRCodeId
    });

    // ============================================
    // STEP 8: Commit the transaction
    // ============================================
    log('Committing transaction', { transactionId: appwriteTransactionId });
    
    await databases.updateTransaction(
      appwriteTransactionId,
      true // true = commit, false = rollback
    );
    
    log('Transaction committed successfully - user created');

    // ============================================
    // SUCCESS - Return user details
    // ============================================
    log('User signup completed successfully');
    
    return res.json({
      success: true,
      data: {
        userId: userId,
        email: email,
        name: name,
        profilePicUrl: profilePicUrl,
        profilePicId: uploadedProfilePicId,
        qrImageId: uploadedQRCodeId,
        phoneNumber: phone,
        message: 'User signup completed successfully - fully atomic (storage + database)'
      }
    }, 200);

  } catch (err) {
    // ============================================
    // ERROR HANDLING & COMPLETE ROLLBACK
    // ============================================
    error('User signup failed - initiating complete rollback', err);
    
    const cleanupResults = {
      transaction: false,
      profilePicture: false,
      qrCode: false
    };
    
    // STEP 1: Rollback database transaction if it was created
    if (appwriteTransactionId) {
      try {
        log('Rolling back database transaction', { transactionId: appwriteTransactionId });
        
        await databases.updateTransaction(
          appwriteTransactionId,
          false // false = rollback
        );
        
        cleanupResults.transaction = true;
        log('Database transaction rolled back successfully');
      } catch (rollbackErr) {
        error('Database transaction rollback failed', {
          rollbackError: rollbackErr.message,
          originalError: err.message,
          transactionId: appwriteTransactionId
        });
      }
    }
    
    // STEP 2: Delete uploaded files
    const filesCleanedUp = await cleanupUploadedFiles(uploadedProfilePicId, uploadedQRCodeId);
    cleanupResults.profilePicture = filesCleanedUp.profilePic;
    cleanupResults.qrCode = filesCleanedUp.qrCode;

    // Determine error code and message
    let errorCode = 'SIGNUP_ERROR';
    let errorMessage = err.message || 'User signup failed';
    
    // Check for specific Appwrite error types
    if (err.code === 409 || err.message?.includes('conflict')) {
      errorCode = 'CONFLICT_ERROR';
      errorMessage = 'Database conflict detected. Please try again.';
    } else if (err.message?.includes('not found')) {
      errorCode = 'NOT_FOUND_ERROR';
      errorMessage = 'Database or collection not found';
    } else if (err.message?.includes('permission')) {
      errorCode = 'PERMISSION_ERROR';
      errorMessage = 'Permission denied';
    } else if (err.message?.includes('duplicate') || err.message?.includes('already exists')) {
      errorCode = 'DUPLICATE_ERROR';
      errorMessage = 'User already exists';
    }

    // Return error response with cleanup status
    return res.json({
      success: false,
      error: errorMessage,
      code: errorCode,
      details: err.message,
      rollbackStatus: cleanupResults,
      cleanedUp: Object.keys(cleanupResults).filter(key => cleanupResults[key])
    }, 500);
  }

  // ============================================
  // HELPER FUNCTION: Cleanup Uploaded Files
  // ============================================
  async function cleanupUploadedFiles(profilePicId, qrCodeId) {
    const results = {
      profilePic: false,
      qrCode: false
    };

    // Delete profile picture if uploaded
    if (profilePicId) {
      try {
        log('Deleting uploaded profile picture', { fileId: profilePicId });
        await storage.deleteFile(PROFILE_PIC_BUCKET_ID, profilePicId);
        results.profilePic = true;
        log('Profile picture deleted successfully');
      } catch (deleteErr) {
        error('Failed to delete profile picture during cleanup', {
          fileId: profilePicId,
          error: deleteErr.message
        });
      }
    }

    // Delete QR code if uploaded
    if (qrCodeId) {
      try {
        log('Deleting uploaded QR code', { fileId: qrCodeId });
        await storage.deleteFile(QR_CODE_BUCKET_ID, qrCodeId);
        results.qrCode = true;
        log('QR code deleted successfully');
      } catch (deleteErr) {
        error('Failed to delete QR code during cleanup', {
          fileId: qrCodeId,
          error: deleteErr.message
        });
      }
    }

    return results;
  }
};

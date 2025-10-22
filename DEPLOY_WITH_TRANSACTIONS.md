# Deploy Appwrite Function with Transactions Support

## Prerequisites

- Appwrite Cloud or Self-Hosted instance (version 1.0+)
- Appwrite CLI installed
- API Key with proper permissions

## Step 1: Update Dependencies

The function requires `node-appwrite` version 16.0.0 or higher for transaction support.

```bash
cd Functions_Appwrite
npm install
```

This will install:
- `node-appwrite@^16.0.0` (or latest)

## Step 2: Verify Environment Variables

Ensure your `.env` or function environment has:

```env
APPWRITE_FUNCTION_API_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_FUNCTION_PROJECT_ID=your_project_id
APPWRITE_API_KEY=your_api_key
DATABASE_ID=your_database_id
```

## Step 3: Deploy Function

### Option A: Via Appwrite Console

1. Go to Appwrite Console → Functions
2. Create new function or select existing `bookTicketAtomic`
3. Upload the `src/bookTicketAtomic.js` file
4. Set Runtime: **Node.js 21** (or latest)
5. Set Entrypoint: `src/bookTicketAtomic.js`
6. Add environment variables listed above
7. Deploy

### Option B: Via CLI

```bash
# Login to Appwrite
appwrite login

# Deploy function
appwrite functions create \
  --functionId bookTicketAtomic \
  --name "Book Ticket Atomic" \
  --runtime "node-21.0" \
  --execute "any" \
  --events ""

# Update function code
appwrite functions updateDeployment \
  --functionId bookTicketAtomic \
  --entrypoint "src/bookTicketAtomic.js" \
  --code "."

# Set environment variables
appwrite functions updateVariables \
  --functionId bookTicketAtomic \
  --variables DATABASE_ID=your_database_id
```

## Step 4: Verify Transaction Support

Test the function with a simple call:

```bash
curl -X POST https://cloud.appwrite.io/v1/functions/bookTicketAtomic/executions \
  -H "Content-Type: application/json" \
  -H "X-Appwrite-Project: YOUR_PROJECT_ID" \
  -H "X-Appwrite-Key: YOUR_API_KEY" \
  -d '{
    "userId": "test_user",
    "eventId": "test_event",
    "eventName": "Test Event",
    ...
  }'
```

Check the logs for:
```
✅ Transaction created successfully: { transactionId: 'txn_...' }
```

## Troubleshooting

### Error: `databases.createTransaction is not a function`

**Cause**: SDK version doesn't support transactions

**Solution**:
1. Update `package.json`:
   ```json
   "dependencies": {
     "node-appwrite": "^16.0.0"
   }
   ```
2. Run `npm install`
3. Redeploy function
4. Ensure runtime is Node.js 18+ (preferably Node.js 21)

### Error: `Transaction not found`

**Cause**: Transaction ID is incorrect or transaction expired

**Solution**:
- Check transaction TTL (default 60 seconds)
- Ensure all operations complete within TTL
- Don't reuse transaction IDs

### Error: `CONFLICT_ERROR`

**Cause**: Another transaction modified the same data

**Solution**:
- This is expected behavior for race conditions
- Implement retry logic on client side
- Show user-friendly error: "Tickets no longer available"

## Verification Checklist

- [ ] `package.json` has `node-appwrite@^16.0.0`
- [ ] Function runtime is Node.js 18+
- [ ] Environment variables are set
- [ ] Function deploys without errors
- [ ] Test execution succeeds
- [ ] Logs show "Transaction created successfully"
- [ ] Booking creates all documents atomically
- [ ] Race condition test: only one booking succeeds

## SDK Version Compatibility

| node-appwrite Version | Transaction Support | Notes |
|----------------------|---------------------|-------|
| < 14.0               | ❌ No               | Use manual rollback |
| 14.x                 | ❌ No               | Upgrade required |
| 15.x                 | ⚠️ Beta             | May have issues |
| 16.0+                | ✅ Yes              | **Recommended** |

## Performance Notes

- Transactions add ~100-200ms overhead
- Keep transactions short-lived (< 10 seconds)
- Maximum 100 operations per transaction
- TTL of 60 seconds is recommended

## Next Steps

After successful deployment:

1. Test single booking flow
2. Test concurrent bookings (race condition)
3. Monitor function logs
4. Update Android app to handle new error codes
5. Test QR code generation flow

## Support

If you encounter issues:
1. Check function logs in Appwrite Console
2. Verify SDK version: `cat node_modules/node-appwrite/package.json`
3. Check Appwrite version: Must be 1.0+
4. Consult: https://appwrite.io/docs/products/databases/transactions


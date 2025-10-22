# Using Appwrite Native Transactions for Atomic Ticket Booking

## 🎉 Major Improvement: Native Database Transactions

The ticket booking function has been upgraded to use **[Appwrite's native database transactions](https://appwrite.io/docs/products/databases/transactions)**, which provides true ACID (Atomicity, Consistency, Isolation, Durability) compliance at the database level.

## 📊 Comparison: Manual Rollback vs Native Transactions

### Previous Approach: Manual Compensation Pattern

```javascript
// OLD: Manual rollback
const createdResources = {
  ticketId: null,
  transactionId: null,
  orderId: null
};

try {
  // Create ticket
  const ticket = await databases.createDocument(...);
  createdResources.ticketId = ticket.$id;
  
  // Create transaction
  const txn = await databases.createDocument(...);
  createdResources.transactionId = txn.$id;
  
  // If this fails, we need manual cleanup
  const order = await databases.createDocument(...);
  
} catch (err) {
  // Manual rollback - delete in reverse order
  if (createdResources.orderId) {
    await databases.deleteDocument(...);
  }
  if (createdResources.transactionId) {
    await databases.deleteDocument(...);
  }
  if (createdResources.ticketId) {
    await databases.deleteDocument(...);
  }
}
```

**Problems**:
- ❌ Not truly atomic (operations are persisted immediately)
- ❌ Race conditions possible between operations
- ❌ Manual cleanup can fail
- ❌ No automatic conflict detection
- ❌ Data can be left inconsistent if rollback fails

### Current Approach: Appwrite Native Transactions

```javascript
// NEW: Native transactions
try {
  // Create transaction
  const transaction = await databases.createTransaction();
  const txnId = transaction.$id;
  
  // All operations are STAGED (not persisted yet)
  await databases.createDocument(..., [], txnId);
  await databases.createDocument(..., [], txnId);
  await databases.updateDocument(..., [], txnId);
  
  // COMMIT - all operations happen atomically or none
  await databases.updateTransaction(txnId, 'commit');
  
} catch (err) {
  // Automatic rollback if transaction exists
  if (txnId) {
    await databases.updateTransaction(txnId, 'rollback');
  }
  // Even if manual rollback fails, uncommitted transactions auto-rollback
}
```

**Benefits**:
- ✅ True ACID compliance
- ✅ All operations staged, nothing persisted until commit
- ✅ Automatic conflict detection
- ✅ Read-your-own-writes within transaction
- ✅ Automatic rollback of uncommitted transactions
- ✅ Better performance (single database transaction)

## 🚀 How It Works

### 1. **Create Transaction**

```javascript
const transaction = await databases.createTransaction();
const transactionId = transaction.$id;

log('Transaction created', { transactionId });
```

Returns a transaction model with a unique ID.

### 2. **Stage Operations**

Pass the `transactionId` as the last parameter to database operations:

```javascript
// Ticket creation - STAGED, not persisted yet
await databases.createDocument(
  DATABASE_ID,
  'tickets',
  ticketId,
  { ...ticketData },
  [],  // permissions
  transactionId  // <-- Makes this operation part of the transaction
);

// Transaction creation - STAGED
await databases.createDocument(
  DATABASE_ID,
  'transactions',
  transactionDocId,
  { ...transactionData },
  [],
  transactionId
);

// Order creation - STAGED
await databases.createDocument(
  DATABASE_ID,
  'orders',
  orderId,
  { ...orderData },
  [],
  transactionId
);

// Event update - STAGED
await databases.updateDocument(
  DATABASE_ID,
  'events',
  eventId,
  { ticketsLeft: newValue },
  [],
  transactionId
);
```

All these operations are **staged** in an internal log. The actual database tables are not modified yet.

### 3. **Commit Transaction**

```javascript
await databases.updateTransaction(transactionId, 'commit');

log('All operations committed atomically');
```

Appwrite replays all staged operations inside a real database transaction. Either:
- ✅ **All operations succeed** → Data is persisted
- ❌ **Any operation fails** → Everything is rolled back automatically

### 4. **Rollback (if needed)**

```javascript
try {
  await databases.updateTransaction(transactionId, 'rollback');
  log('Transaction rolled back');
} catch (err) {
  // Even if this fails, uncommitted transactions auto-rollback after timeout
}
```

## 📋 Supported Operations

The following operations support `transactionId` parameter:

| Operation | Method | Supported |
|-----------|--------|-----------|
| Create row | `createDocument()` | ✅ Yes |
| Update row | `updateDocument()` | ✅ Yes |
| Delete row | `deleteDocument()` | ✅ Yes |
| Upsert row | `upsertDocument()` | ✅ Yes |
| Increment | `incrementAttribute()` | ✅ Yes |
| Decrement | `decrementAttribute()` | ✅ Yes |
| Bulk create | `createRows()` | ✅ Yes |
| Bulk update | `updateRows()` | ✅ Yes |
| Bulk delete | `deleteRows()` | ✅ Yes |
| List/Get | `listDocuments()`, `getDocument()` | ✅ Yes (sees staged changes) |

**Note**: Schema operations (creating/deleting collections/attributes) are **not** included in transactions.

## 🎯 Key Features

### 1. Read-Your-Own-Writes

Operations within a transaction see earlier staged changes:

```javascript
// Create ticket
await databases.createDocument(..., ticketId, ticketData, [], txnId);

// This GET will see the staged ticket (even though not committed yet)
const ticket = await databases.getDocument(..., ticketId, [], txnId);
```

### 2. Conflict Detection

If any row modified by your transaction changes externally before commit, the commit fails:

```javascript
// User A: Stages buying last ticket
await databases.updateDocument(..., eventId, { ticketsLeft: 0 }, [], txnIdA);

// User B: Stages buying same last ticket  
await databases.updateDocument(..., eventId, { ticketsLeft: 0 }, [], txnIdB);

// User A commits first - SUCCESS
await databases.updateTransaction(txnIdA, 'commit'); // ✅

// User B commits - FAILS with conflict
await databases.updateTransaction(txnIdB, 'commit'); // ❌ Conflict!
```

### 3. Cross-Database & Cross-Table

You can stage operations across multiple databases and tables:

```javascript
// Ticket in tickets collection
await databases.createDocument(DB_ID, 'tickets', ..., [], txnId);

// Transaction in transactions collection
await databases.createDocument(DB_ID, 'transactions', ..., [], txnId);

// Order in orders collection
await databases.createDocument(DB_ID, 'orders', ..., [], txnId);

// Event in events collection
await databases.updateDocument(DB_ID, 'events', ..., [], txnId);

// All committed together atomically!
await databases.updateTransaction(txnId, 'commit');
```

## 📏 Limits

Transaction limits by plan:

| Plan | Max Operations | Max Duration |
|------|----------------|--------------|
| Free | 100 | 15 seconds |
| Pro | 1,000 | 15 seconds |
| Scale | 2,500 | 15 seconds |

**Best Practices**:
- Keep transactions short-lived
- Don't exceed operation limits
- Commit/rollback within 15 seconds

## 🔒 ACID Guarantees

### Atomicity ✅
All operations succeed together or none persist.

### Consistency ✅
Database goes from one valid state to another valid state.

### Isolation ✅
Concurrent transactions don't interfere with each other.

### Durability ✅
Once committed, data persists even after system failures.

## 🆚 Benefits Over Manual Rollback

| Feature | Manual Rollback | Native Transactions |
|---------|-----------------|---------------------|
| **Atomicity** | ❌ Partial (operations persist immediately) | ✅ True (nothing persists until commit) |
| **Conflict Detection** | ❌ Manual checks needed | ✅ Automatic |
| **Race Conditions** | ⚠️ Possible | ✅ Prevented |
| **Cleanup** | ❌ Manual, can fail | ✅ Automatic |
| **Performance** | ⚠️ Multiple round trips | ✅ Single database transaction |
| **Code Complexity** | ❌ High | ✅ Low |
| **Error Handling** | ❌ Complex | ✅ Simple |
| **Data Consistency** | ⚠️ Can be inconsistent | ✅ Always consistent |

## 💡 Real-World Example: Ticket Booking

### Scenario: Two users try to buy the last ticket simultaneously

**With Manual Rollback** ⚠️:
```
User A: Creates ticket ✅ (persisted)
User B: Creates ticket ✅ (persisted) 
User A: Updates event (1 ticket left → 0) ✅
User B: Updates event (1 ticket left → 0) ✅

Result: Both got tickets, but there was only 1! ❌
```

**With Native Transactions** ✅:
```
User A: Stages ticket creation (not persisted)
User B: Stages ticket creation (not persisted)
User A: Stages event update (not persisted)
User B: Stages event update (not persisted)
User A: Commits transaction ✅ (all A's operations persist)
User B: Commits transaction ❌ (conflict detected, auto-rollback)

Result: Only User A got the ticket ✅
```

## 🧪 Testing

### Test Conflict Detection:

```javascript
// Terminal 1: Start transaction but don't commit
const txn1 = await databases.createTransaction();
await databases.updateDocument(DB_ID, 'events', eventId, 
  { ticketsLeft: 0 }, [], txn1.$id);
// Wait before committing...

// Terminal 2: Try to update same event
const txn2 = await databases.createTransaction();
await databases.updateDocument(DB_ID, 'events', eventId, 
  { ticketsLeft: 0 }, [], txn2.$id);
await databases.updateTransaction(txn2.$id, 'commit'); // ✅ Succeeds

// Terminal 1: Now commit
await databases.updateTransaction(txn1.$id, 'commit'); // ❌ Conflict!
```

### Test Rollback:

```javascript
const txn = await databases.createTransaction();

// Stage operations
await databases.createDocument(..., [], txn.$id);
await databases.createDocument(..., [], txn.$id);

// Rollback instead of commit
await databases.updateTransaction(txn.$id, 'rollback');

// Verify: Documents should NOT exist in database
```

## 📚 Migration from Manual Rollback

If you're updating from the manual rollback approach:

### Before:
```javascript
const resources = { ticketId: null, txnId: null };
try {
  const ticket = await databases.createDocument(...);
  resources.ticketId = ticket.$id;
  // ...
} catch (err) {
  // Manual cleanup
  if (resources.ticketId) {
    await databases.deleteDocument(...);
  }
}
```

### After:
```javascript
const txn = await databases.createTransaction();
try {
  await databases.createDocument(..., [], txn.$id);
  // ...
  await databases.updateTransaction(txn.$id, 'commit');
} catch (err) {
  await databases.updateTransaction(txn.$id, 'rollback');
}
```

**Key Changes**:
1. Create transaction first
2. Add `transactionId` parameter to all operations
3. Commit at the end
4. Simple rollback (no manual cleanup)

## 🎓 Learn More

- [Appwrite Transactions Documentation](https://appwrite.io/docs/products/databases/transactions)
- [Appwrite Database API Reference](https://appwrite.io/docs/references/cloud/server-nodejs/databases)
- [ACID Properties Explained](https://en.wikipedia.org/wiki/ACID)

## ✅ Summary

Appwrite native transactions provide:

✅ **True Atomicity** - All or nothing  
✅ **Automatic Conflict Detection** - No race conditions  
✅ **Simple Code** - Less complexity  
✅ **Better Performance** - Single DB transaction  
✅ **Guaranteed Consistency** - Always valid state  
✅ **Automatic Rollback** - No manual cleanup  

This is a **significant upgrade** from manual rollback and provides enterprise-grade data consistency for ticket bookings.

---

**Last Updated**: October 22, 2025  
**Appwrite Version**: 1.6+ (Transactions feature)  
**Status**: ✅ Production Ready


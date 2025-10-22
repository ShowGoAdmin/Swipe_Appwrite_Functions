/**
 * Test script to verify Appwrite Transactions support
 * 
 * Run this locally to check if your SDK version supports transactions:
 * node test_transactions.js
 */

import { Client, Databases } from 'node-appwrite';

// Color codes for terminal output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testTransactionSupport() {
  log('\n========================================', 'blue');
  log('Appwrite Transaction Support Test', 'blue');
  log('========================================\n', 'blue');

  // Step 1: Check SDK version
  log('Step 1: Checking SDK version...', 'yellow');
  try {
    const packageJson = await import('./package.json', { assert: { type: 'json' } });
    const sdkVersion = packageJson.default.dependencies['node-appwrite'];
    log(`✓ node-appwrite version: ${sdkVersion}`, 'green');
    
    const versionNumber = parseInt(sdkVersion.replace(/[^\d]/g, ''));
    if (versionNumber < 16) {
      log(`⚠ WARNING: Version ${sdkVersion} may not support transactions`, 'yellow');
      log(`  Transactions require node-appwrite v16.0.0+`, 'yellow');
    }
  } catch (err) {
    log(`✗ Could not read package.json: ${err.message}`, 'red');
  }

  // Step 2: Check if methods exist
  log('\nStep 2: Checking if transaction methods exist...', 'yellow');
  
  const client = new Client();
  const databases = new Databases(client);

  const methods = [
    'createTransaction',
    'updateTransaction',
    'getTransaction',
    'listTransactions'
  ];

  let allMethodsExist = true;
  for (const method of methods) {
    const exists = typeof databases[method] === 'function';
    if (exists) {
      log(`✓ databases.${method}() exists`, 'green');
    } else {
      log(`✗ databases.${method}() NOT FOUND`, 'red');
      allMethodsExist = false;
    }
  }

  // Step 3: Summary
  log('\n========================================', 'blue');
  log('Test Summary', 'blue');
  log('========================================\n', 'blue');

  if (allMethodsExist) {
    log('✓ Transaction Support: YES', 'green');
    log('  Your SDK version supports Appwrite Transactions!', 'green');
    log('  You can use bookTicketAtomic.js as-is.\n', 'green');
  } else {
    log('✗ Transaction Support: NO', 'red');
    log('  Your SDK version does NOT support transactions.', 'red');
    log('\n  Solutions:', 'yellow');
    log('  1. Update package.json: "node-appwrite": "^16.0.0"', 'yellow');
    log('  2. Run: npm install', 'yellow');
    log('  3. Redeploy your function', 'yellow');
    log('  4. OR use bookTicketAtomic_v2.js (has fallback)\n', 'yellow');
  }

  // Step 4: Next steps
  log('Next Steps:', 'blue');
  log('1. If transactions are supported:', 'reset');
  log('   - Deploy Functions_Appwrite/src/bookTicketAtomic.js', 'reset');
  log('   - Ensure runtime is Node.js 18+', 'reset');
  log('\n2. If transactions are NOT supported:', 'reset');
  log('   - Update package.json to node-appwrite@^16.0.0', 'reset');
  log('   - Run: npm install', 'reset');
  log('   - Redeploy function', 'reset');
  log('   - OR use bookTicketAtomic_v2.js (auto-fallback)\n', 'reset');
}

// Run the test
testTransactionSupport().catch(err => {
  log(`\n✗ Test failed: ${err.message}`, 'red');
  log(`  ${err.stack}\n`, 'red');
  process.exit(1);
});


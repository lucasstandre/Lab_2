const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// DEBUG: Log Plaid version and environment
console.log('🔍 Plaid Environment:', process.env.PLAID_ENV || 'sandbox');
console.log('🔍 Plaid Client ID:', process.env.PLAID_CLIENT_ID ? 'Set' : 'Not set');
console.log('🔍 Plaid Secret:', process.env.PLAID_SECRET ? 'Set' : 'Not set');

// Initialize Plaid client
const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(configuration);

// DEBUG: Log available methods on client
console.log('🔍 Client constructor name:', client.constructor.name);
console.log('🔍 Available client methods:', Object.getOwnPropertyNames(client));
console.log('🔍 Available prototype methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)));

// Test endpoint
router.get('/status', authenticateToken, (req, res) => {
  res.json({ 
    message: 'Plaid integration ready', 
    user_id: req.user_id,
    plaid_env: process.env.PLAID_ENV || 'sandbox',
    client_methods: Object.getOwnPropertyNames(Object.getPrototypeOf(client)).slice(0, 10)
  });
});

// Create link token
router.post('/create_link_token', authenticateToken, async (req, res) => {
  try {
    console.log('🔗 Creating link token for user:', req.user_id);
    
    const request = {
      user: {
        client_user_id: req.user_id.toString(),
      },
      client_name: 'Budget App',
      products: ['transactions', 'investments'], // Add investments for holdings data
      country_codes: ['CA'],
      language: 'en',
    };

    console.log('🔗 Link token request:', JSON.stringify(request, null, 2));

    const response = await client.linkTokenCreate(request);
    
    console.log('✅ Link token created successfully');
    console.log('🔗 Link token (first 20 chars):', response.data.link_token.substring(0, 20) + '...');
    
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('❌ Error creating link token:', error.message);
    console.error('❌ Full error:', error);
    res.status(500).json({ error: 'Failed to create link token: ' + error.message });
  }
});

// FIXED: Exchange public token - USE CORRECT METHOD NAME
router.post('/exchange_public_token', authenticateToken, async (req, res) => {
  try {
    const { public_token } = req.body;
    
    console.log('🔄 Attempting to exchange public token');
    console.log('🔄 Public token (first 20 chars):', public_token ? public_token.substring(0, 20) + '...' : 'undefined');
    console.log('🔄 User ID:', req.user_id);
    
    // CORRECT: Use itemPublicTokenExchange (from debug output)
    console.log('✅ Using itemPublicTokenExchange method');
    const response = await client.itemPublicTokenExchange({
      public_token: public_token,
    });

    console.log('✅ Token exchange successful');
    
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    
    console.log('🔑 Access token (first 20 chars):', accessToken.substring(0, 20) + '...');
    console.log('🏦 Item ID:', itemId);

    // Create user_banks table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_banks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        item_id VARCHAR(255) NOT NULL,
        access_token VARCHAR(500) NOT NULL,
        institution_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, item_id)
      )
    `);

    // Store access token in database
    const query = `
      INSERT INTO user_banks (user_id, item_id, access_token, institution_name) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, item_id) 
      DO UPDATE SET access_token = $3, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    
    const dbResult = await pool.query(query, [req.user_id, itemId, accessToken, 'Connected Bank']);
    
    console.log('💾 Bank connection saved to database');

    res.json({ 
      success: true,
      message: 'Bank connected successfully',
      institution_name: 'Connected Bank',
      accounts: 1 // Default for now
    });
  } catch (error) {
    console.error('❌ Error exchanging public token:', error.message);
    console.error('❌ Full error:', error);
    res.status(500).json({ error: 'Failed to exchange token: ' + error.message });
  }
});

// Define Plaid categories that are clear enough to auto-categorize
const AUTO_CATEGORIZE_PLAID_CATEGORIES = [
  'INCOME',
  'PAYROLL', 
  'DEPOSIT',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'BANK_FEES',
  'ATM_FEES',
  'INTEREST_EARNED',
  'INTEREST_CHARGED',
  'LOAN_PAYMENTS',
  'CREDIT_CARD_PAYMENT',
  'INSURANCE',
  'TAXES',
  'UTILITIES',
  'RENT_AND_UTILITIES',
  'MORTGAGE_AND_RENT'
];

// Helper function to add categorization data efficiently
const addCategorizationData = async (transactions, userId, banksResult, allAccounts) => {
  // Only query categorizations if we have transactions
  if (transactions.length === 0) {
    return transactions;
  }

  // Get existing categorizations for this user (optimized query)
  const categorizationsQuery = 'SELECT transaction_id, category FROM transaction_categorizations WHERE user_id = $1';
  const categorizationsResult = await pool.query(categorizationsQuery, [userId]);
  
  // Create maps for quick lookup
  const categorizationMap = {};
  categorizationsResult.rows.forEach(row => {
    categorizationMap[row.transaction_id] = row.category;
  });

  // Create bank lookup map for better performance
  const bankMap = {};
  banksResult.rows.forEach(bank => {
    bankMap[bank.id] = bank.institution_name;
  });

  // Add user_category and bank_name to each transaction
  return transactions.map(transaction => ({
    ...transaction,
    user_category: categorizationMap[transaction.transaction_id] || null,
    bank_name: 'Connected Bank' // Simplified for performance
  }));
};

// Helper function to auto-categorize clear transactions and add manual review transactions
const processTransactionsForCategorization = async (transactions, userId) => {
  if (transactions.length === 0) return { autoCount: 0, manualCount: 0 };

  let autoCategorizationPromises = [];
  let manualReviewTransactions = [];
  
  // Get existing categorizations to avoid duplicates
  const existingCategorizations = await pool.query(
    'SELECT transaction_id FROM transaction_categorizations WHERE user_id = $1',
    [userId]
  );
  const categorizedIds = new Set(existingCategorizations.rows.map(row => row.transaction_id));

  // Get existing manual review transactions to avoid duplicates
  const existingManualReview = await pool.query(
    'SELECT transaction_id FROM manual_review_transactions WHERE user_id = $1',
    [userId]
  );
  const manualReviewIds = new Set(existingManualReview.rows.map(row => row.transaction_id));

  for (const tx of transactions) {
    // Skip if already categorized or already in manual review
    if (categorizedIds.has(tx.transaction_id) || manualReviewIds.has(tx.transaction_id)) {
      continue;
    }

    const plaidCategory = tx.personal_finance_category?.primary;
    
    if (plaidCategory && AUTO_CATEGORIZE_PLAID_CATEGORIES.includes(plaidCategory)) {
      // Auto-categorize this transaction
      const cleanCategory = plaidCategory.replace(/_/g, ' ').toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
        
      autoCategorizationPromises.push(
        pool.query(`
          INSERT INTO transaction_categorizations (user_id, transaction_id, category, plaid_data) 
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, transaction_id) DO NOTHING
        `, [userId, tx.transaction_id, cleanCategory, JSON.stringify(tx)])
      );
    } else {
      // Add to manual review
      manualReviewTransactions.push(tx);
    }
  }

  // Process auto-categorizations
  if (autoCategorizationPromises.length > 0) {
    await Promise.all(autoCategorizationPromises);
    console.log(`✅ Auto-categorized ${autoCategorizationPromises.length} transactions`);
  }

  // Add manual review transactions to the table
  if (manualReviewTransactions.length > 0) {
    const insertPromises = manualReviewTransactions.map(tx =>
      pool.query(`
        INSERT INTO manual_review_transactions (user_id, transaction_id, transaction_data) 
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, transaction_id) DO NOTHING
      `, [userId, tx.transaction_id, JSON.stringify(tx)])
    );
    
    await Promise.all(insertPromises);
    console.log(`✅ Added ${manualReviewTransactions.length} transactions for manual review`);
  }

  return { 
    autoCount: autoCategorizationPromises.length, 
    manualCount: manualReviewTransactions.length 
  };
};

// Get transactions - SIMPLIFIED AND FAST
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const banksQuery = 'SELECT * FROM user_banks WHERE user_id = $1';
    const banksResult = await pool.query(banksQuery, [req.user_id]);
    
    if (banksResult.rows.length === 0) {
      return res.json({ transactions: [], accounts: [] });
    }

    let allTransactions = [];
    let allAccounts = [];

    // Set default date range (last 30 days)
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const startDateStr = startDate.toISOString().split('T')[0];

    console.log(`📅 Fetching transactions from ${startDateStr} to ${endDate}`);

    // Fetch transactions from each bank
    for (const bank of banksResult.rows) {
      try {
        const transactionRequest = {
          access_token: bank.access_token,
          start_date: startDateStr,
          end_date: endDate,
        };

        const transactionResponse = await client.transactionsGet(transactionRequest);
        const accountsResponse = await client.accountsGet({ 
          access_token: bank.access_token 
        });
        
        allTransactions = allTransactions.concat(transactionResponse.data.transactions);
        allAccounts = allAccounts.concat(accountsResponse.data.accounts);
      } catch (error) {
        console.error(`❌ Error fetching transactions for bank ${bank.id}:`, error.message);
      }
    }

    console.log(`📊 Total transactions found: ${allTransactions.length}`);

    // Process transactions for categorization (auto-categorize and add to manual review)
    const { autoCount, manualCount } = await processTransactionsForCategorization(allTransactions, req.user_id);

    res.json({ 
      transactions: allTransactions,
      accounts: allAccounts,
      processing_summary: {
        total: allTransactions.length,
        auto_categorized: autoCount,
        manual_review_added: manualCount
      }
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// POST version for frontend compatibility - SIMPLIFIED
router.post('/transactions', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    
    const banksQuery = 'SELECT * FROM user_banks WHERE user_id = $1';
    const banksResult = await pool.query(banksQuery, [req.user_id]);
    
    if (banksResult.rows.length === 0) {
      return res.json({ transactions: [], accounts: [] });
    }

    let allTransactions = [];
    let allAccounts = [];

    // Use provided dates or default to last 30 days
    const endDateStr = end_date || new Date().toISOString().split('T')[0];
    const startDateObj = start_date ? new Date(start_date) : new Date();
    if (!start_date) {
      startDateObj.setDate(startDateObj.getDate() - 30);
    }
    const startDateStr = start_date || startDateObj.toISOString().split('T')[0];

    console.log(`📅 POST: Fetching transactions from ${startDateStr} to ${endDateStr}`);

    // Fetch transactions from each bank
    for (const bank of banksResult.rows) {
      try {
        const transactionRequest = {
          access_token: bank.access_token,
          start_date: startDateStr,
          end_date: endDateStr,
        };

        const transactionResponse = await client.transactionsGet(transactionRequest);
        const accountsResponse = await client.accountsGet({ 
          access_token: bank.access_token 
        });
        
        allTransactions = allTransactions.concat(transactionResponse.data.transactions);
        allAccounts = allAccounts.concat(accountsResponse.data.accounts);
      } catch (error) {
        console.error(`❌ Error fetching transactions for bank ${bank.id}:`, error.message);
      }
    }

    console.log(`📊 Total transactions found: ${allTransactions.length}`);

    // Process transactions for categorization
    const { autoCount, manualCount } = await processTransactionsForCategorization(allTransactions, req.user_id);

    res.json({ 
      transactions: allTransactions,
      accounts: allAccounts,
      processing_summary: {
        total: allTransactions.length,
        auto_categorized: autoCount,
        manual_review_added: manualCount
      }
    });
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// NEW: Get transactions for manual review - SUPER FAST
router.get('/transactions/manual-review', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT transaction_data 
      FROM manual_review_transactions 
      WHERE user_id = $1 
      ORDER BY created_at ASC
    `;
    
    const result = await pool.query(query, [req.user_id]);
    
    const transactions = result.rows.map(row => row.transaction_data);
    
    console.log(`📋 Found ${transactions.length} transactions for manual review`);
    
    res.json({ 
      transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('❌ Error fetching manual review transactions:', error);
    res.status(500).json({ error: 'Failed to fetch manual review transactions' });
  }
});

// Add categorizations endpoint
router.get('/categorizations', authenticateToken, async (req, res) => {
  try {
    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transaction_categorizations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        transaction_id VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        plaid_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, transaction_id)
      )
    `);

    const query = 'SELECT * FROM transaction_categorizations WHERE user_id = $1';
    const result = await pool.query(query, [req.user_id]);
    
    res.json({ categorizations: result.rows });
  } catch (error) {
    console.error('Error fetching categorizations:', error);
    res.status(500).json({ error: 'Failed to fetch categorizations' });
  }
});

// UPDATED: Categorize endpoint - removes from manual review
router.post('/categorize', authenticateToken, async (req, res) => {
  try {
    const { transaction_id, category, plaid_data } = req.body;
    
    // Add categorization
    const categorizationQuery = `
      INSERT INTO transaction_categorizations (user_id, transaction_id, category, plaid_data) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, transaction_id) 
      DO UPDATE SET category = $3, plaid_data = $4, created_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    
    const result = await pool.query(categorizationQuery, [
      req.user_id, 
      transaction_id, 
      category, 
      JSON.stringify(plaid_data)
    ]);
    
    // Remove from manual review table
    await pool.query(`
      DELETE FROM manual_review_transactions 
      WHERE user_id = $1 AND transaction_id = $2
    `, [req.user_id, transaction_id]);
    
    console.log(`✅ Categorized transaction ${transaction_id} as "${category}" and removed from manual review`);
    
    res.json({ 
      success: true, 
      categorization: result.rows[0] 
    });
  } catch (error) {
    console.error('Error categorizing transaction:', error);
    res.status(500).json({ error: 'Failed to categorize transaction' });
  }
});

// Get connected banks
router.get('/banks', authenticateToken, async (req, res) => {
  try {
    console.log('🏦 Fetching connected banks for user:', req.user_id);
    
    const query = `
      SELECT 
        id,
        institution_name, 
        created_at,
        item_id
      FROM user_banks 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query, [req.user_id]);
    
    console.log(`✅ Found ${result.rows.length} connected banks`);
    
    res.json({ 
      banks: result.rows.map(bank => ({
        id: bank.id,
        institution_name: bank.institution_name || 'Connected Bank',
        created_at: bank.created_at,
        item_id: bank.item_id
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching banks:', error);
    res.status(500).json({ error: 'Failed to fetch banks' });
  }
});

// Get accounts only
router.get('/accounts', authenticateToken, async (req, res) => {
  try {
    console.log('🏦 Fetching accounts for user:', req.user_id);
    
    const banksQuery = 'SELECT * FROM user_banks WHERE user_id = $1';
    const banksResult = await pool.query(banksQuery, [req.user_id]);
    
    if (banksResult.rows.length === 0) {
      return res.json({ accounts: [], banks: [] });
    }

    let allAccounts = [];
    const bankSummary = [];

    // Fetch accounts from each bank
    for (const bank of banksResult.rows) {
      try {
        console.log(`🏦 Fetching accounts for bank ID: ${bank.id}`);
        
        const accountsResponse = await client.accountsGet({ 
          access_token: bank.access_token 
        });
        
        console.log(`✅ Found ${accountsResponse.data.accounts.length} accounts for bank ${bank.id}`);
        
        // Add bank info to each account
        const accountsWithBank = accountsResponse.data.accounts.map(account => ({
          ...account,
          bank_id: bank.id,
          bank_name: bank.institution_name,
          item_id: bank.item_id
        }));
        
        allAccounts = allAccounts.concat(accountsWithBank);
        
        bankSummary.push({
          bank_id: bank.id,
          bank_name: bank.institution_name,
          account_count: accountsResponse.data.accounts.length,
          item_id: bank.item_id
        });
        
        // DEBUG: Log account details for this bank
        console.log(`  Accounts for ${bank.institution_name}:`);
        accountsResponse.data.accounts.forEach((account, index) => {
          console.log(`    ${index + 1}. ${account.name} (${account.type}/${account.subtype})`);
          console.log(`       Balance: $${account.balances.current || 'N/A'}`);
          console.log(`       Account ID: ${account.account_id}`);
        });
        
      } catch (error) {
        console.error(`❌ Error fetching accounts for bank ${bank.id}:`, error.message);
      }
    }

    console.log(`📊 Total accounts found: ${allAccounts.length}`);
    console.log(`🏦 Banks summary:`, bankSummary);

    res.json({ 
      accounts: allAccounts,
      banks: bankSummary,
      total_accounts: allAccounts.length,
      total_banks: banksResult.rows.length
    });
  } catch (error) {
    console.error('❌ Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Get holdings for investment accounts
router.get('/holdings', authenticateToken, async (req, res) => {
  try {
    console.log('📈 Fetching holdings for user:', req.user_id);
    
    const banksQuery = 'SELECT * FROM user_banks WHERE user_id = $1';
    const banksResult = await pool.query(banksQuery, [req.user_id]);
    
    if (banksResult.rows.length === 0) {
      console.log('❌ No banks found for user');
      return res.json({ holdings: [], securities: [], total_holdings: 0, total_securities: 0 });
    }

    console.log(`🏦 Found ${banksResult.rows.length} banks for user`);

    let allHoldings = [];
    let allSecurities = [];

    // Fetch holdings from each bank
    for (const bank of banksResult.rows) {
      try {
        console.log(`📈 Fetching holdings for bank ID: ${bank.id} (${bank.institution_name})`);
        console.log(`🔑 Access token: ${bank.access_token ? 'Present' : 'Missing'}`);
        
        // First check if this bank has investment accounts
        const accountsResponse = await client.accountsGet({ 
          access_token: bank.access_token 
        });
        
        console.log(`🏦 Found ${accountsResponse.data.accounts.length} total accounts for bank ${bank.id}`);
        
        const investmentAccounts = accountsResponse.data.accounts.filter(account => 
          account.type === 'investment' || account.subtype === 'brokerage'
        );
        
        console.log(`💼 Found ${investmentAccounts.length} investment accounts for bank ${bank.id}`);
        
        if (investmentAccounts.length === 0) {
          console.log(`ℹ️ No investment accounts found for bank ${bank.id}`);
          continue;
        }
        
        // Log investment accounts details
        investmentAccounts.forEach((account, index) => {
          console.log(`  ${index + 1}. ${account.name} (ID: ${account.account_id}, Type: ${account.type}/${account.subtype})`);
        });
        
        // Fetch holdings using the Plaid investments endpoint
        console.log(`🔍 Calling Plaid investmentsHoldingsGet for bank ${bank.id}...`);
        
        const holdingsResponse = await client.investmentsHoldingsGet({
          access_token: bank.access_token
        });
        
        console.log(`✅ Plaid response for bank ${bank.id}:`, {
          holdings_count: holdingsResponse.data.holdings?.length || 0,
          securities_count: holdingsResponse.data.securities?.length || 0,
          item_id: holdingsResponse.data.item?.item_id || 'Unknown'
        });
        
        // Debug: Log the raw holdings data
        if (holdingsResponse.data.holdings && holdingsResponse.data.holdings.length > 0) {
          console.log(`📊 Raw holdings data:`, holdingsResponse.data.holdings.slice(0, 3)); // First 3 holdings
        }
        
        if (holdingsResponse.data.securities && holdingsResponse.data.securities.length > 0) {
          console.log(`🔐 Raw securities data:`, holdingsResponse.data.securities.slice(0, 3)); // First 3 securities
        }
        
        // Add bank and account info to holdings
        const holdingsWithInfo = (holdingsResponse.data.holdings || []).map(holding => {
          const account = accountsResponse.data.accounts.find(acc => acc.account_id === holding.account_id);
          return {
            ...holding,
            bank_id: bank.id,
            bank_name: bank.institution_name,
            account_name: account?.name || 'Unknown Account',
            account_type: account?.type || 'Unknown',
            account_subtype: account?.subtype || 'Unknown'
          };
        });
        
        allHoldings = allHoldings.concat(holdingsWithInfo);
        
        // Add securities info (avoid duplicates)
        (holdingsResponse.data.securities || []).forEach(security => {
          if (!allSecurities.find(s => s.security_id === security.security_id)) {
            allSecurities.push(security);
          }
        });
        
        // DEBUG: Log holdings details
        console.log(`  📈 Holdings summary for ${bank.institution_name}:`);
        holdingsWithInfo.forEach((holding, index) => {
          const security = holdingsResponse.data.securities?.find(s => s.security_id === holding.security_id);
          const marketValue = holding.institution_value || (holding.quantity * holding.institution_price);
          console.log(`    ${index + 1}. ${security?.ticker_symbol || security?.name || 'Unknown'}`);
          console.log(`       Account: ${holding.account_name} (${holding.account_id})`);
          console.log(`       Quantity: ${holding.quantity}`);
          console.log(`       Price: $${holding.institution_price || 'N/A'}`);
          console.log(`       Value: $${marketValue || 'N/A'}`);
        });
        
      } catch (error) {
        console.error(`❌ Error fetching holdings for bank ${bank.id}:`, {
          message: error.message,
          stack: error.stack?.split('\n')[0],
          plaid_error: error.response?.data || 'No Plaid error details'
        });
        // Continue with other banks even if one fails
      }
    }

    console.log(`📊 Final results - Holdings: ${allHoldings.length}, Securities: ${allSecurities.length}`);

    res.json({ 
      holdings: allHoldings,
      securities: allSecurities,
      total_holdings: allHoldings.length,
      total_securities: allSecurities.length
    });
  } catch (error) {
    console.error('❌ Error in holdings endpoint:', {
      message: error.message,
      stack: error.stack?.split('\n')[0]
    });
    res.status(500).json({ error: 'Failed to fetch holdings', details: error.message });
  }
});

// Disconnect/delete bank connection
router.delete('/banks/:bankId', authenticateToken, async (req, res) => {
  try {
    const { bankId } = req.params;
    console.log(`🗑️ Disconnecting bank ${bankId} for user ${req.user_id}`);
    
    // Get bank details first
    const bankQuery = 'SELECT * FROM user_banks WHERE id = $1 AND user_id = $2';
    const bankResult = await pool.query(bankQuery, [bankId, req.user_id]);
    
    if (bankResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bank connection not found' });
    }
    
    const bank = bankResult.rows[0];
    
    try {
      // Remove item from Plaid (optional - will automatically clean up)
      await client.itemRemove({
        access_token: bank.access_token
      });
      console.log('✅ Removed item from Plaid');
    } catch (plaidError) {
      console.log('⚠️ Could not remove from Plaid (item may already be removed):', plaidError.message);
    }
    
    // Remove from database
    await pool.query('DELETE FROM user_banks WHERE id = $1 AND user_id = $2', [bankId, req.user_id]);
    
    console.log(`✅ Bank ${bankId} disconnected successfully`);
    
    res.json({ 
      success: true, 
      message: 'Bank disconnected successfully' 
    });
  } catch (error) {
    console.error('❌ Error disconnecting bank:', error);
    res.status(500).json({ error: 'Failed to disconnect bank' });
  }
});

// Add this new endpoint to get current stock prices
router.get('/current-prices/:symbols', authenticateToken, async (req, res) => {
  try {
    const symbols = req.params.symbols.split(',');
    const currentPrices = {};
    
    for (const symbol of symbols) {
      try {
        // Using Yahoo Finance API (free, no key required)
        const response = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
        );
        const data = await response.json();
        
        if (data.chart?.result?.[0]?.meta?.regularMarketPrice) {
          const price = data.chart.result[0].meta.regularMarketPrice;
          const previousClose = data.chart.result[0].meta.previousClose;
          const change = price - previousClose;
          const changePercent = ((change / previousClose) * 100).toFixed(2);
          
          currentPrices[symbol] = {
            price: price,
            change: change,
            changePercent: `${changePercent}%`,
            previousClose: previousClose
          };
          
          console.log(`📈 ${symbol}: $${price} (${changePercent >= 0 ? '+' : ''}${changePercent}%)`);
        } else {
          console.log(`⚠️ No price data found for ${symbol}`);
        }
      } catch (error) {
        console.error(`❌ Error fetching price for ${symbol}:`, error);
      }
    }
    
    console.log('📊 Final current prices:', currentPrices);
    res.json({ currentPrices });
  } catch (error) {
    console.error('Error fetching current prices:', error);
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

// Get liabilities (minimum payments, due dates, etc.)
router.get('/liabilities', authenticateToken, async (req, res) => {
  try {
    console.log('💳 Fetching liabilities for user:', req.user_id);
    
    // Get all access tokens for the user
    const banksQuery = 'SELECT * FROM connected_banks WHERE user_id = $1';
    const banksResult = await pool.query(banksQuery, [req.user_id]);
    
    if (banksResult.rows.length === 0) {
      return res.json({ liabilities: { credit: [], mortgage: [], student: [] } });
    }

    let allLiabilities = {
      credit: [],
      mortgage: [],
      student: []
    };

    // Fetch liabilities from each connected bank
    for (const bank of banksResult.rows) {
      try {
        console.log(`💰 Fetching liabilities for bank ${bank.institution_name}...`);
        
        const liabilitiesRequest = {
          access_token: bank.access_token,
        };

        const response = await client.liabilitiesGet(liabilitiesRequest);
        const liabilities = response.data.liabilities;
        
        console.log(`💳 Liabilities found:`, {
          credit: liabilities.credit?.length || 0,
          mortgage: liabilities.mortgage?.length || 0,
          student: liabilities.student?.length || 0
        });

        // Merge liabilities from this bank
        if (liabilities.credit) {
          allLiabilities.credit.push(...liabilities.credit.map(credit => ({
            ...credit,
            bank_name: bank.institution_name,
            bank_id: bank.id
          })));
        }
        
        if (liabilities.mortgage) {
          allLiabilities.mortgage.push(...liabilities.mortgage.map(mortgage => ({
            ...mortgage,
            bank_name: bank.institution_name,
            bank_id: bank.id
          })));
        }
        
        if (liabilities.student) {
          allLiabilities.student.push(...liabilities.student.map(student => ({
            ...student,
            bank_name: bank.institution_name,
            bank_id: bank.id
          })));
        }

      } catch (error) {
        console.error(`❌ Error fetching liabilities for bank ${bank.id}:`, {
          message: error.message,
          plaid_error: error.response?.data || 'No Plaid error details'
        });
        // Continue with other banks even if one fails
      }
    }

    console.log(`📊 Final liabilities summary:`, {
      credit: allLiabilities.credit.length,
      mortgage: allLiabilities.mortgage.length,
      student: allLiabilities.student.length
    });

    res.json({ liabilities: allLiabilities });

  } catch (error) {
    console.error('❌ Error in liabilities endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to fetch liabilities',
      details: error.message 
    });
  }
});

module.exports = router;
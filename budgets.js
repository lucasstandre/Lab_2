const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Ensure budgets table exists
const ensureBudgetsTable = async () => {
  try {
    // First check if table exists
    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'budgets'
      );
    `;
    
    const tableExistsResult = await pool.query(tableExistsQuery);
    const tableExists = tableExistsResult.rows[0].exists;
    
    if (!tableExists) {
      // Only create if it doesn't exist
      await pool.query(`
        CREATE TABLE budgets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          category VARCHAR(100) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          month VARCHAR(7) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, category, month)
        )
      `);
      
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id)
      `);
      
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month)
      `);
      
      console.log('✅ Budgets table created successfully');
    } else {
      console.log('✅ Budgets table already exists');
    }
  } catch (error) {
    // If we get a permission error but the table exists, that's OK
    if (error.code === '42501') {
      console.log('ℹ️ Budgets table exists but no owner permissions - this is OK for operations');
    } else {
      console.error('❌ Error with budgets table:', error.message);
    }
  }
};

// Initialize table on startup
ensureBudgetsTable();

// GET /api/budgets - Get user's budgets
router.get('/', authenticateToken, async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const query = `
      SELECT id, category, amount, month, created_at, updated_at
      FROM budgets 
      WHERE user_id = $1 AND month = $2
      ORDER BY category
    `;
    
    const result = await pool.query(query, [req.user_id, currentMonth]);
    res.json({ budgets: result.rows });
  } catch (error) {
    console.error('Error fetching budgets:', error);
    res.status(500).json({ error: 'Failed to fetch budgets' });
  }
});

// POST /api/budgets - Create/update budget
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { category, amount, month } = req.body;
    
    if (!category || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Category and amount are required' });
    }

    // Ensure amount is a valid number
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({ error: 'Amount must be a valid positive number' });
    }

    const currentMonth = month || new Date().toISOString().slice(0, 7);
    
    console.log('💰 Saving budget:', { 
      user_id: req.user_id, 
      category, 
      amount: numericAmount, 
      month: currentMonth 
    });
    
    // FIXED: Correct parameter order in ON CONFLICT clause
    const query = `
      INSERT INTO budgets (user_id, category, amount, month) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, category, month) 
      DO UPDATE SET amount = $3, updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    
    const result = await pool.query(query, [req.user_id, category, numericAmount, currentMonth]);
    
    console.log('✅ Budget saved successfully:', result.rows[0]);
    res.json({ budget: result.rows[0], message: 'Budget saved successfully' });
  } catch (error) {
    console.error('Error saving budget:', error);
    
    // If it's a table doesn't exist error, try to create it
    if (error.code === '42P01') {
      try {
        await ensureBudgetsTable();
        // Retry the operation
        const { category, amount, month } = req.body;
        const numericAmount = parseFloat(amount);
        const currentMonth = month || new Date().toISOString().slice(0, 7);
        
        const query = `
          INSERT INTO budgets (user_id, category, amount, month) 
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, category, month) 
          DO UPDATE SET amount = $3, updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `;
        
        const result = await pool.query(query, [req.user_id, category, numericAmount, currentMonth]);
        res.json({ budget: result.rows[0], message: 'Budget saved successfully' });
      } catch (retryError) {
        console.error('Error on retry after table creation:', retryError);
        res.status(500).json({ error: 'Failed to save budget: ' + retryError.message });
      }
    } else {
      res.status(500).json({ error: 'Failed to save budget: ' + error.message });
    }
  }
});

// DELETE /api/budgets/:id - Delete budget
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const budgetId = req.params.id;
    
    const query = `
      DELETE FROM budgets 
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;
    
    const result = await pool.query(query, [budgetId, req.user_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Budget not found' });
    }
    
    res.json({ message: 'Budget deleted successfully', budget: result.rows[0] });
  } catch (error) {
    console.error('Error deleting budget:', error);
    res.status(500).json({ error: 'Failed to delete budget' });
  }
});

module.exports = router;
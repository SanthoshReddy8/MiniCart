const path = require('node:path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const requestCount = Number(process.env.REQUEST_COUNT || 20);
const databaseUrl = process.env.DATABASE_URL || `postgres://ecommerce:${process.env.DB_PASSWORD || 'changeme'}@localhost:5432/ecommerce`;
const jwtSecret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

async function prepare() {
  const pool = new Pool({ connectionString: databaseUrl });
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const category = await client.query(
      `INSERT INTO categories (name) VALUES ($1) RETURNING id`, [`Concurrency ${runId}`]
    );
    const product = await client.query(
      `INSERT INTO products (category_id, name, description, price, stock_quantity)
       VALUES ($1, $2, $3, $4, 1) RETURNING id`,
      [category.rows[0].id, `Concurrency product ${runId}`, 'One unit concurrency fixture', 1]
    );
    const passwordHash = await bcrypt.hash('ConcurrencyPassword123!', 10);
    const tokens = [];
    for (let index = 0; index < requestCount; index += 1) {
      const user = await client.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        [`concurrency-${runId}-${index}@example.com`, passwordHash]
      );
      await client.query(
        'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, 1)',
        [user.rows[0].id, product.rows[0].id]
      );
      tokens.push(jwt.sign({ sub: user.rows[0].id, email: `concurrency-${runId}-${index}@example.com`, role: 'user' }, jwtSecret, { expiresIn: '15m' }));
    }
    await client.query('COMMIT');
    console.log(`PRODUCT_ID=${product.rows[0].id}`);
    console.log(`TOKENS=${tokens.join(',')}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

prepare().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
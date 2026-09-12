const path = require('node:path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const API_URL = process.env.API_URL || 'http://localhost:4000';
const databaseUrl = process.env.DATABASE_URL || `postgres://ecommerce:${process.env.DB_PASSWORD || 'changeme'}@localhost:5432/ecommerce`;
const jwtSecret = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

async function prepare(pool, runId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const category = await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [`Idempotency ${runId}`]);
    const product = await client.query(
      `INSERT INTO products (category_id, name, description, price, stock_quantity)
       VALUES ($1, $2, $3, $4, 1) RETURNING id`,
      [category.rows[0].id, `Idempotency product ${runId}`, 'Idempotency fixture', 1]
    );
    const email = `idempotency-${runId}@example.com`;
    const passwordHash = await bcrypt.hash('IdempotencyPassword123!', 10);
    const user = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, passwordHash]
    );
    await client.query('INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, 1)', [user.rows[0].id, product.rows[0].id]);
    await client.query('COMMIT');
    return jwt.sign({ sub: user.rows[0].id, email, role: 'user' }, jwtSecret, { expiresIn: '15m' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function testIdempotency() {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const token = await prepare(pool, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const idempotencyKey = `idempotency-test-${Date.now()}`;
    const request = () => axios.post(`${API_URL}/api/orders`, {}, {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey },
      validateStatus: () => true
    });
    const responses = await Promise.all([request(), request(), request()]);
    const orderIds = new Set(responses.filter((response) => response.status === 201).map((response) => response.data.orderId));
    console.log(`Responses: ${responses.map((response) => response.status).join(', ')}`);
    console.log(`Unique order IDs created: ${orderIds.size}`);
    if (orderIds.size !== 1 || responses.some((response) => response.status !== 201)) {
      console.error('FAIL: idempotent requests did not replay the same successful order.');
      process.exitCode = 1;
      return;
    }
    console.log('PASS: three concurrent requests created exactly one order.');
  } finally {
    await pool.end();
  }
}

testIdempotency().catch((error) => {
  console.error('Idempotency test failed:', error);
  process.exitCode = 1;
});
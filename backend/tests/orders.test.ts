import crypto from 'node:crypto';
import request from 'supertest';
import Stripe from 'stripe';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-at-least-32-characters';
process.env.STRIPE_SECRET_KEY ??= 'sk_test_placeholder';
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_test_secret';

type QueryResult = { rows: any[]; rowCount: number };

class FakeClient {
  private readonly results: QueryResult[];
  constructor(results: QueryResult[], private readonly log: string[]) { this.results = results; }
  async query(sql: string): Promise<QueryResult> { this.log.push(sql); return this.results.shift() ?? { rows: [], rowCount: 0 }; }
  release(): void {}
}

class FakePool {
  public readonly queries: string[] = [];
  private readonly clients: FakeClient[];
  constructor(results: QueryResult[][]) { this.clients = results.map((items) => new FakeClient(items, this.queries)); }
  async connect(): Promise<FakeClient> { return this.clients.shift() ?? new FakeClient([], this.queries); }
  async query(sql: string): Promise<QueryResult> { this.queries.push(sql); return { rows: [], rowCount: 0 }; }
}

const redis = {
  multi: () => ({
    zRemRangeByScore() { return this; }, zCard() { return this; }, zAdd() { return this; }, expire() { return this; },
    async exec() { return [0, 0, 0, 0]; }
  }),
  ttl: async () => 60,
  del: async () => 1,
  get: async () => null,
  set: async () => undefined,
  incr: async () => 1
} as any;

const result = (rows: any[] = [], rowCount = rows.length): QueryResult => ({ rows, rowCount });

async function loadApp(pool: FakePool) {
  return (await import('../src/app.js')).createApp(pool as any, redis);
}

async function authHeader() {
  const jwt = await import('jsonwebtoken');
  return `Bearer ${jwt.default.sign({ sub: 'user-1', email: 'user@example.com', role: 'user' }, process.env.JWT_ACCESS_SECRET!, { expiresIn: '15m' })}`;
}

describe('POST /api/orders', () => {
  it('rejects order when cart is empty', async () => {
    const pool = new FakePool([[result(), result([{ user_id: 'user-1' }]), result([], 0)]]);
    const response = await request(await loadApp(pool)).post('/api/orders').set('Authorization', await authHeader()).set('Idempotency-Key', 'empty-cart').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Cart is empty');
  });

  it('returns 409 when optimistic stock update affects zero rows', async () => {
    const pool = new FakePool([[result(), result([{ user_id: 'user-1' }]), result([{ product_id: 'product-1', quantity: 1, version: 2, stock_quantity: 1 }]), result([{ id: 'order-conflict' }]), result([], 0)]]);
    const response = await request(await loadApp(pool)).post('/api/orders').set('Authorization', await authHeader()).set('Idempotency-Key', 'stock-conflict').send({});
    expect(response.status).toBe(409);
    expect(response.body.details.productId).toBe('product-1');
  });

  it('returns the same order on duplicate idempotency key', async () => {
    const orderBody = { orderId: 'order-1', status: 'pending', total: 10 };
    const pool = new FakePool([[result(), result([], 0), result([{ request_hash: crypto.createHash('sha256').update('{}').digest('hex'), status_code: 201, response_json: orderBody }])]]);
    const response = await request(await loadApp(pool)).post('/api/orders').set('Authorization', await authHeader()).set('Idempotency-Key', 'duplicate-key').send({});
    expect(response.status).toBe(201);
    expect(response.body).toEqual(orderBody);
  });

  it('decrements stock exactly once per successful order', async () => {
    const pool = new FakePool([[
      result(), result([{ user_id: 'user-1' }]),
      result([{ product_id: 'product-1', quantity: 1, version: 1, stock_quantity: 1 }]),
      result([{ id: 'order-1' }]), result([{ price: '10.00' }]), result(), result(), result(), result(), result(), result()
    ]]);
    const response = await request(await loadApp(pool)).post('/api/orders').set('Authorization', await authHeader()).set('Idempotency-Key', 'success-key').send({});
    expect(response.status).toBe(201);
    expect(pool.queries.filter((query) => query.includes('UPDATE products')).length).toBe(1);
  });
});

describe('Webhook handler', () => {
  beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret'; });

  it('rejects requests with invalid Stripe signature', async () => {
    const pool = new FakePool([]);
    const response = await request(await loadApp(pool)).post('/api/payments/webhook').set('stripe-signature', 'invalid').set('Content-Type', 'application/json').send(JSON.stringify({ id: 'evt_invalid', type: 'payment_intent.succeeded', data: { object: {} } }));
    expect(response.status).toBe(400);
  });

  it('does not reprocess an already-handled event id', async () => {
    const pool = new FakePool([[result(), result([], 0), result([], 0), result(), result(), result()]]);
    const app = await loadApp(pool);
    const stripe = new Stripe('sk_test_placeholder');
    const payload = JSON.stringify({ id: 'evt_duplicate', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' } } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
    const response = await request(app).post('/api/payments/webhook').set('stripe-signature', signature).set('Content-Type', 'application/json').send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(pool.queries.filter((query) => query.includes('UPDATE orders')).length).toBe(0);
  });
});
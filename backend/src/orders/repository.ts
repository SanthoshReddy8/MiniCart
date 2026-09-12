import type { Pool, PoolClient } from 'pg';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
type OrderResponse = { orderId: string; status: 'pending'; total: number };
export type OutboxEvent = { id: string; eventType: string; aggregateId: string; payload: Record<string, unknown> };
export type PaymentOrder = { id: string; status: OrderStatus; email: string; total: number; items: Array<{ name: string; price: number; quantity: number }> };

export class OrderError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export class OrderRepository {
  constructor(private readonly db: Pool) {}

  async placeOrder(userId: string, idempotencyKey: string, requestHash: string): Promise<{ body: OrderResponse; statusCode: number; replayed: boolean }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        `INSERT INTO order_idempotency_keys (user_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING user_id`, [userId, idempotencyKey, requestHash]
      );
      if (claim.rowCount === 0) {
        const existing = await client.query(
          'SELECT request_hash, status_code, response_json FROM order_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) throw new OrderError(409, 'Idempotency key was already used for another request');
        await client.query('COMMIT');
        return { body: row.response_json as OrderResponse, statusCode: row.status_code ?? 201, replayed: true };
      }

      const cart = await client.query(
        `SELECT ci.product_id, ci.quantity, p.price, p.version, p.stock_quantity
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
         WHERE ci.user_id = $1 ORDER BY ci.product_id`, [userId]
      );
      if (cart.rowCount === 0) throw new OrderError(400, 'Cart is empty');

      const order = await client.query('INSERT INTO orders (user_id, total_amount) VALUES ($1, 0) RETURNING id', [userId]);
      const orderId = order.rows[0].id as string;
      let total = 0;
      for (const item of cart.rows) {
        const inventory = await client.query(
          `UPDATE products
           SET stock_quantity = stock_quantity - $1, version = version + 1, updated_at = NOW()
           WHERE id = $2 AND version = $3 AND stock_quantity >= $1
           RETURNING price`, [item.quantity, item.product_id, item.version]
        );
        if (inventory.rowCount !== 1) {
          throw new OrderError(409, 'Inventory changed; please review your cart and try again', { productId: item.product_id });
        }
        const unitPrice = Number(inventory.rows[0].price);
        total += unitPrice * item.quantity;
        await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [orderId, item.product_id, item.quantity, unitPrice]
        );
      }
      total = Number(total.toFixed(2));
      await client.query('UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2', [total, orderId]);
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      const body: OrderResponse = { orderId, status: 'pending', total };
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, payload)
         VALUES ($1, $2, $3)`,
        ['order.created', orderId, JSON.stringify({ orderId, userId, total, status: 'pending' })]
      );
      await client.query(
        `UPDATE order_idempotency_keys SET order_id = $1, status_code = 201, response_json = $2 WHERE user_id = $3 AND idempotency_key = $4`,
        [orderId, JSON.stringify(body), userId, idempotencyKey]
      );
      await client.query('COMMIT');
      return { body, statusCode: 201, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPendingOutboxEvents(limit = 50): Promise<OutboxEvent[]> {
    const result = await this.db.query(
      `SELECT id, event_type, aggregate_id, payload FROM outbox_events
       WHERE published_at IS NULL ORDER BY created_at LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ id: row.id, eventType: row.event_type, aggregateId: row.aggregate_id, payload: row.payload }));
  }

  async markOutboxPublished(id: string): Promise<void> {
    await this.db.query('UPDATE outbox_events SET published_at = NOW() WHERE id = $1 AND published_at IS NULL', [id]);
  }

  async listOrders(userId: string): Promise<Array<{ id: string; status: OrderStatus; total: number; createdAt: string }>> {
    const result = await this.db.query(
      'SELECT id, status, total_amount, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId]
    );
    return result.rows.map((row) => ({ id: row.id, status: row.status, total: Number(row.total_amount), createdAt: row.created_at.toISOString() }));
  }

  async getOrder(userId: string, orderId: string): Promise<{ id: string; status: OrderStatus; total: number; createdAt: string; items: Array<{ productId: string; quantity: number; unitPrice: number }> } | null> {
    const result = await this.db.query(
      `SELECT o.id, o.status, o.total_amount, o.created_at, oi.product_id, oi.quantity, oi.unit_price
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1 AND o.user_id = $2 ORDER BY oi.product_id`, [orderId, userId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return { id: row.id, status: row.status, total: Number(row.total_amount), createdAt: row.created_at.toISOString(),
      items: result.rows.filter((item) => item.product_id).map((item) => ({ productId: item.product_id, quantity: item.quantity, unitPrice: Number(item.unit_price) })) };
  }

  async getOrderForPayment(userId: string, orderId: string): Promise<PaymentOrder | null> {
    const result = await this.db.query(
      `SELECT o.id, o.status, u.email, oi.quantity, oi.unit_price, p.name
       FROM orders o JOIN users u ON u.id = o.user_id
       JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
       WHERE o.id = $1 AND o.user_id = $2 ORDER BY oi.product_id`, [orderId, userId]
    );
    if (!result.rows.length) return null;
    return {
      id: result.rows[0].id, status: result.rows[0].status, email: result.rows[0].email, total: result.rows.reduce((sum, row) => sum + Number(row.unit_price) * row.quantity, 0),
      items: result.rows.map((row) => ({ name: row.name, price: Number(row.unit_price), quantity: row.quantity }))
    };
  }

  async savePaymentIntent(orderId: string, paymentIntentId: string): Promise<void> {
    await this.db.query('UPDATE orders SET stripe_payment_intent_id = $1, updated_at = NOW() WHERE id = $2 AND status = \'pending\'', [paymentIntentId, orderId]);
    await this.db.query(
      `INSERT INTO payments (order_id, stripe_payment_intent_id, status)
       VALUES ($1, $2, 'requires_payment')
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET updated_at = NOW()`, [orderId, paymentIntentId]
    );
  }

  async saveCheckoutSession(orderId: string, sessionId: string): Promise<void> {
    await this.db.query('UPDATE orders SET stripe_checkout_session_id = $1, updated_at = NOW() WHERE id = $2 AND status = \'pending\'', [sessionId, orderId]);
  }

  async markPaidFromStripeWebhook(eventId: string, paymentIntentId: string, orderId: string): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const event = await client.query(
        `INSERT INTO processed_webhook_events (event_id) VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId]
      );
      if (event.rowCount === 0) {
        await client.query('COMMIT');
        return false;
      }
      const updated = await client.query(
        `UPDATE orders SET status = 'paid', stripe_payment_intent_id = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'`, [paymentIntentId, orderId]
      );
      await client.query(
        `INSERT INTO payments (order_id, stripe_payment_intent_id, status)
         VALUES ($1, $2, 'succeeded')
         ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'succeeded', updated_at = NOW()`,
        [orderId, paymentIntentId]
      );
      if (updated.rowCount === 1) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_id, payload)
           VALUES ($1, $2, $3)`,
          ['order.paid', orderId, JSON.stringify({ orderId, paymentIntentId, status: 'paid' })]
        );
      }
      await client.query('COMMIT');
      return updated.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markPaymentFailedFromStripeWebhook(eventId: string, paymentIntentId: string, orderId?: string): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const event = await client.query(
        `INSERT INTO processed_webhook_events (event_id) VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId]
      );
      if (event.rowCount === 0) {
        await client.query('COMMIT');
        return false;
      }
      const payment = await client.query(
        `UPDATE payments SET status = 'failed', updated_at = NOW()
         WHERE stripe_payment_intent_id = $1 RETURNING id`, [paymentIntentId]
      );
      if (payment.rowCount === 0 && orderId) {
        await client.query(
          `INSERT INTO payments (order_id, stripe_payment_intent_id, status)
           VALUES ($1, $2, 'failed') ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'failed', updated_at = NOW()`,
          [orderId, paymentIntentId]
        );
      }
      await client.query('COMMIT');
      return payment.rowCount === 1 || Boolean(orderId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionStatus(orderId: string, nextStatus: OrderStatus): Promise<boolean> {
    const allowedPrevious: Record<OrderStatus, OrderStatus[]> = {
      pending: [], paid: ['pending'], shipped: ['paid'], delivered: ['shipped'], cancelled: ['pending', 'paid']
    };
    const previous = allowedPrevious[nextStatus];
    if (!previous.length) return false;
    const result = await this.db.query(
      `UPDATE orders SET status = $1, updated_at = NOW()
       WHERE id = $2 AND status = ANY($3::order_status[])`, [nextStatus, orderId, previous]
    );
    return result.rowCount === 1;
  }
}
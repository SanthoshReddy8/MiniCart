import type { Pool, PoolClient } from 'pg';

export type CartItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  stockQuantity: number;
};

export class CartError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export class CartRepository {
  constructor(private readonly db: Pool) {}

  async getCart(userId: string): Promise<CartItem[]> {
    const result = await this.db.query(
      `SELECT ci.product_id, p.name, p.price, ci.quantity, p.stock_quantity
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1 ORDER BY ci.updated_at DESC`, [userId]
    );
    return result.rows.map((row) => ({
      productId: row.product_id, name: row.name, price: Number(row.price),
      quantity: row.quantity, stockQuantity: row.stock_quantity
    }));
  }

  async addItem(userId: string, productId: string, quantity: number): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const product = await this.lockProduct(client, productId);
      const existing = await client.query('SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
      const nextQuantity = (existing.rows[0]?.quantity ?? 0) + quantity;
      if (nextQuantity > product.stock_quantity) {
        throw new CartError(409, 'Insufficient stock', { available: Math.max(0, product.stock_quantity - (existing.rows[0]?.quantity ?? 0)) });
      }
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
        [userId, productId, nextQuantity]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateItem(userId: string, productId: string, quantity: number): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const product = await this.lockProduct(client, productId);
      if (quantity > product.stock_quantity) throw new CartError(409, 'Insufficient stock', { available: product.stock_quantity });
      const result = await client.query(
        'UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE user_id = $2 AND product_id = $3',
        [quantity, userId, productId]
      );
      if (result.rowCount !== 1) throw new CartError(404, 'Cart item not found');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async removeItem(userId: string, productId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
    return result.rowCount === 1;
  }

  async validateCheckout(userId: string): Promise<{ valid: boolean; unavailable: Array<{ productId: string; requested: number; available: number }> }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT ci.product_id, ci.quantity, p.stock_quantity
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
         WHERE ci.user_id = $1 ORDER BY ci.product_id FOR UPDATE OF p`, [userId]
      );
      const unavailable = result.rows
        .filter((row) => row.quantity > row.stock_quantity)
        .map((row) => ({ productId: row.product_id, requested: row.quantity, available: row.stock_quantity }));
      await client.query('COMMIT');
      return { valid: unavailable.length === 0, unavailable };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockProduct(client: PoolClient, productId: string): Promise<{ stock_quantity: number }> {
    const result = await client.query('SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (!result.rows[0]) throw new CartError(404, 'Product not found');
    return result.rows[0];
  }
}
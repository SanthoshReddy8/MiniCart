import type { Pool, PoolClient } from 'pg';
import type { Role } from './tokens';

export type User = { id: string; email: string; passwordHash: string; role: Role };

export class AuthRepository {
  constructor(private readonly db: Pool) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.db.query('SELECT id, email, password_hash, role FROM users WHERE email = $1', [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role } : null;
  }

  async createUser(email: string, passwordHash: string): Promise<User> {
    const result = await this.db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, password_hash, role',
      [email, passwordHash]
    );
    const row = result.rows[0];
    return { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role };
  }

  async saveRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, tokenHash, expiresAt]);
  }

  async revokeRefreshToken(userId: string, tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2', [userId, tokenHash]);
  }

  async rotateRefreshToken(tokenHash: string, replacement: { hash: string; expiresAt: Date }): Promise<User | null> {
    const client: PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const tokenResult = await client.query(
        'DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id', [tokenHash]
      );
      const userId = tokenResult.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const userResult = await client.query('SELECT id, email, password_hash, role FROM users WHERE id = $1', [userId]);
      const row = userResult.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, replacement.hash, replacement.expiresAt]);
      await client.query('COMMIT');
      return { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
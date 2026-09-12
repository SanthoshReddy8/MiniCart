import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET = 'a-test-secret-that-is-long-enough-32';
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_placeholder';
});

describe('refresh tokens', () => {
  it('creates an opaque token and only stores its hash', async () => {
    const { createRefreshToken, hashToken } = await import('../src/auth/tokens.js');
    const token = createRefreshToken();
    expect(token.raw).not.toBe(token.hash);
    expect(hashToken(token.raw)).toBe(token.hash);
    expect(token.raw.length).toBeGreaterThan(40);
  });
});
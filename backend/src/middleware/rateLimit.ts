import type { NextFunction, Request, Response } from 'express';
type RedisLike = { multi: () => any; ttl: (key: string) => Promise<number>; del: (key: string) => Promise<number> };

type RateLimitOptions = { windowSeconds: number; max: number; prefix: string; keySource?: 'ip' | 'email-or-ip' };

export function getRateLimitKey(request: Request, options: RateLimitOptions): string {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const identifier = options.keySource === 'email-or-ip' && email ? `email:${encodeURIComponent(email)}` : `ip:${request.ip}`;
  return `${options.prefix}:${identifier}`;
}

export async function resetRateLimit(redis: RedisLike, request: Request, options: RateLimitOptions): Promise<void> {
  await redis.del(getRateLimitKey(request, options));
}

export function rateLimit(redis: RedisLike, options: RateLimitOptions) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const key = getRateLimitKey(request, options);
    const now = Date.now();
    const windowStart = now - options.windowSeconds * 1000;
    const transaction = redis.multi();
    transaction.zRemRangeByScore(key, 0, windowStart);
    transaction.zCard(key);
    transaction.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    transaction.expire(key, options.windowSeconds);
    const result = await transaction.exec();
    const count = Number(result?.[1] ?? 0);
    if (count >= options.max) {
      const ttl = await redis.ttl(key);
      response.status(429).json({ error: 'Too many requests', retryAfterSeconds: Math.max(0, ttl) });
      return;
    }
    next();
  };
}
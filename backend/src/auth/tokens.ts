import crypto from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';

export type Role = 'user' | 'admin';
export type AccessClaims = JwtPayload & { sub: string; email: string; role: Role };

export function createAccessToken(user: { id: string; email: string; role: Role }): string {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.JWT_ACCESS_SECRET, {
    expiresIn: config.ACCESS_TOKEN_TTL
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, config.JWT_ACCESS_SECRET);
  if (typeof payload === 'string' || typeof payload.sub !== 'string' ||
      (payload.role !== 'user' && payload.role !== 'admin') || typeof payload.email !== 'string') {
    throw new Error('Invalid access token claims');
  }
  return payload as AccessClaims;
}

export function createRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400000);
  return { raw, hash, expiresAt };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
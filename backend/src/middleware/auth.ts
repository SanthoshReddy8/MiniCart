import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type AccessClaims, type Role } from '../auth/tokens';

declare global {
  namespace Express { interface Request { auth?: AccessClaims } }
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  try {
    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token');
    request.auth = verifyAccessToken(header.slice(7));
    next();
  } catch {
    response.status(401).json({ error: 'Unauthorized' });
  }
}

export function requireRole(role: Role) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.auth?.role !== role) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
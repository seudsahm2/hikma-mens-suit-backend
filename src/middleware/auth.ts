import type { NextFunction, Request, Response } from 'express';
import type { Role, User } from '@prisma/client';
import { verifyToken } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Attaches req.user if a valid token is present. Never rejects. */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readToken(req);
    const payload = token ? verifyToken(token) : null;
    if (payload) {
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (user && user.isActive) req.user = user;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const requireStaff = requireRole('ADMIN', 'OWNER');
export const requireOwner = requireRole('OWNER');

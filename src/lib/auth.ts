import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';

export interface TokenPayload {
  sub: string;
  role: Role;
}

const TTL: Record<Role, string> = {
  CUSTOMER: '60d',
  ADMIN: '12h',
  OWNER: '12h',
};

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TTL[payload.role] } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    if (typeof decoded.sub !== 'string' || typeof decoded.role !== 'string') return null;
    return { sub: decoded.sub, role: decoded.role as Role };
  } catch {
    return null;
  }
}

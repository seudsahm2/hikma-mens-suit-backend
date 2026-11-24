import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { TelegramIdentity } from './telegramVerify';

/**
 * "Sign in through the bot":
 *   1. the website asks for a one-time token and opens t.me/<bot>?start=login_<token>
 *   2. the user taps Start; the bot receives /start login_<token> with their Telegram identity
 *      (Telegram guarantees ctx.from — it can't be forged by the user)
 *   3. the website polls with the token and receives a session once the bot has confirmed it
 *
 * Tokens are stored in the database (hashed), so they survive restarts, Render's free-plan sleep and
 * deploys, and work with several server instances.
 */
export const LOGIN_TOKEN_TTL_SECONDS = 10 * 60;

/** base64url keeps it inside Telegram's start-parameter alphabet [A-Za-z0-9_-]; 32 chars + "login_" ≤ 64. */
export function newLoginToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token);
}

export async function createLoginToken(): Promise<{ token: string; expiresAt: Date }> {
  // Opportunistic cleanup keeps the table small without a cron job
  await prisma.loginToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
  const token = newLoginToken();
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_SECONDS * 1000);
  await prisma.loginToken.create({ data: { id: hashLoginToken(token), expiresAt } });
  return { token, expiresAt };
}

/** Called by the bot when the user taps Start. Returns false if the token is unknown or expired. */
export async function confirmLoginToken(token: string, identity: TelegramIdentity): Promise<boolean> {
  if (!isWellFormedToken(token)) return false;
  const result = await prisma.loginToken.updateMany({
    where: { id: hashLoginToken(token), expiresAt: { gt: new Date() }, confirmedAt: null },
    data: {
      telegramId: BigInt(identity.id),
      identity: identity as unknown as Prisma.InputJsonValue,
      confirmedAt: new Date(),
    },
  });
  return result.count === 1;
}

export type LoginTokenState = { status: 'pending' } | { status: 'expired' } | { status: 'confirmed'; identity: TelegramIdentity };

/** Website polling. A confirmed token is consumed atomically, so it signs in exactly once. */
export async function checkLoginToken(token: string): Promise<LoginTokenState> {
  if (!isWellFormedToken(token)) return { status: 'expired' };
  const id = hashLoginToken(token);
  const row = await prisma.loginToken.findUnique({ where: { id } });
  if (!row || row.expiresAt < new Date()) return { status: 'expired' };
  if (!row.confirmedAt || !row.identity) return { status: 'pending' };
  // Delete-then-return: two simultaneous polls can't both get a session
  const deleted = await prisma.loginToken.deleteMany({ where: { id, confirmedAt: { not: null } } });
  if (deleted.count !== 1) return { status: 'expired' };
  return { status: 'confirmed', identity: row.identity as unknown as TelegramIdentity };
}

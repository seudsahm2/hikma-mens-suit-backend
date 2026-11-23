import { randomBytes } from 'node:crypto';
import type { TelegramIdentity } from './telegramVerify';

/**
 * "Sign in through the bot":
 *   1. the website asks for a one-time token and opens t.me/<bot>?start=login_<token>
 *   2. the user taps Start; the bot receives /start login_<token> together with their verified Telegram identity
 *   3. the website polls with the token and receives a session once the bot has confirmed it
 *
 * Tokens live in memory for 5 minutes (one server instance; a login takes seconds).
 */
const TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 5000;

interface Entry {
  expires: number;
  identity: TelegramIdentity | null;
}

const tokens = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
}

export function createLoginToken(): string {
  sweep();
  if (tokens.size >= MAX_PENDING) throw new Error('Too many pending logins');
  // base64url keeps it inside Telegram's allowed start-parameter characters [A-Za-z0-9_-]
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, { expires: Date.now() + TTL_MS, identity: null });
  return token;
}

/** Called by the bot when the user taps Start. Returns false if the token is unknown or expired. */
export function confirmLoginToken(token: string, identity: TelegramIdentity): boolean {
  const entry = tokens.get(token);
  if (!entry || entry.expires < Date.now()) return false;
  entry.identity = identity;
  return true;
}

export type LoginTokenState = { status: 'pending' } | { status: 'expired' } | { status: 'confirmed'; identity: TelegramIdentity };

/** Website polling. A confirmed token is consumed (works once). */
export function checkLoginToken(token: string): LoginTokenState {
  const entry = tokens.get(token);
  if (!entry || entry.expires < Date.now()) {
    tokens.delete(token);
    return { status: 'expired' };
  }
  if (!entry.identity) return { status: 'pending' };
  tokens.delete(token);
  return { status: 'confirmed', identity: entry.identity };
}

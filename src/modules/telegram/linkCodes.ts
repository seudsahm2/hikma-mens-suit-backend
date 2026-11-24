import { randomInt } from 'node:crypto';
import { prisma } from '../../lib/prisma';

export type LinkPurpose = 'admin' | 'channel';

const TTL_MS = 15 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One-time code the owner sends to the bot ("/link CODE") to connect a chat or the channel. */
export async function createLinkCode(purpose: LinkPurpose): Promise<string> {
  await prisma.linkCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  await prisma.linkCode.create({ data: { code, purpose, expiresAt: new Date(Date.now() + TTL_MS) } });
  return code;
}

export type LinkResult = { ok: true } | { ok: false; reason: 'invalid' | 'wrong_place'; purpose?: LinkPurpose };

/**
 * Uses the code if it exists, hasn't expired and is meant for `expected`.
 * A code sent in the wrong place is NOT used up, so it can be re-sent in the right place.
 */
export async function consumeLinkCode(raw: string, expected: LinkPurpose): Promise<LinkResult> {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return { ok: false, reason: 'invalid' };
  const entry = await prisma.linkCode.findUnique({ where: { code } });
  if (!entry || entry.expiresAt < new Date()) {
    if (entry) await prisma.linkCode.delete({ where: { code } }).catch(() => undefined);
    return { ok: false, reason: 'invalid' };
  }
  const purpose: LinkPurpose = entry.purpose === 'channel' ? 'channel' : 'admin';
  if (purpose !== expected) return { ok: false, reason: 'wrong_place', purpose };
  await prisma.linkCode.delete({ where: { code } }).catch(() => undefined);
  return { ok: true };
}

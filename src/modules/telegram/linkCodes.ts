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

/** Returns the purpose and deletes the code, or null if it's unknown or expired. */
export async function consumeLinkCode(raw: string): Promise<LinkPurpose | null> {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return null;
  const entry = await prisma.linkCode.findUnique({ where: { code } });
  if (!entry) return null;
  await prisma.linkCode.delete({ where: { code } }).catch(() => undefined);
  if (entry.expiresAt < new Date()) return null;
  return entry.purpose === 'channel' ? 'channel' : 'admin';
}

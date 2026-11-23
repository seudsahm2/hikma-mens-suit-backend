import { randomInt } from 'node:crypto';

export type LinkPurpose = 'admin' | 'channel';

const TTL_MS = 10 * 60 * 1000;
const codes = new Map<string, { purpose: LinkPurpose; expires: number }>();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One-time code the owner sends to the bot in the admin group / channel to link it. */
export function createLinkCode(purpose: LinkPurpose): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  codes.set(code, { purpose, expires: Date.now() + TTL_MS });
  return code;
}

export function consumeLinkCode(code: string): LinkPurpose | null {
  const entry = codes.get(code);
  codes.delete(code);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.purpose;
}

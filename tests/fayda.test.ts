import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseFayda, verifyFayda } from '../src/modules/identity/fayda';

// A throw-away key pair: cards are built exactly like the fayda_decoder fixtures (synthetic, never a real person)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const testPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const FACE = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function card({ name = 'Abebe Kebede Alemu', fields = 'V:4:G:M:A:6140123412341234:D:2002/11/26', signed = true } = {}) {
  const external = `${b64(FACE)}:DLT:${name}:${fields}`;
  if (!signed) return `${external}:SIGN:`;
  const header = b64('{"alg":"RS256"}');
  const sig = sign('RSA-SHA256', Buffer.from(`${header}.${b64(external)}`), privateKey);
  return `${external}:SIGN:${header}..${b64(sig)}`;
}

describe('Fayda QR', () => {
  it('reads every field', () => {
    const r = parseFayda(card());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card).toMatchObject({ fullName: 'Abebe Kebede Alemu', gender: 'male', fan: '6140123412341234', dateOfBirth: '2002-11-26', version: '4' });
    expect(r.card.face?.subarray(0, 4).toString()).toBe('RIFF');
  });

  it('verifies a genuine signature', () => {
    const r = parseFayda(card());
    expect(r.ok && verifyFayda(r.card, testPem).verified).toBe(true);
  });

  it('keeps Ethiopic names exactly', () => {
    const r = parseFayda(card({ name: 'አበበ ከበደ አለሙ' }));
    expect(r.ok && r.card.fullName).toBe('አበበ ከበደ አለሙ');
    expect(r.ok && verifyFayda(r.card, testPem).verified).toBe(true);
  });

  it('rejects a card whose name or ID number was changed', () => {
    const forgedName = card().replace('Abebe Kebede Alemu', 'Someone Else Here');
    const r1 = parseFayda(forgedName);
    expect(r1.ok && verifyFayda(r1.card, testPem)).toEqual({ verified: false, reason: 'BAD_SIGNATURE' });
    const forgedFan = card().replace('6140123412341234', '6140999999999999');
    const r2 = parseFayda(forgedFan);
    expect(r2.ok && verifyFayda(r2.card, testPem).verified).toBe(false);
  });

  it('rejects a card signed by another key (the real NIDP key does not accept test cards)', () => {
    const r = parseFayda(card());
    expect(r.ok && verifyFayda(r.card).verified).toBe(false);
  });

  it('handles unsigned, non-Fayda and unknown versions', () => {
    const u = parseFayda(card({ signed: false }));
    expect(u.ok && verifyFayda(u.card, testPem)).toEqual({ verified: false, reason: 'NO_SIGNATURE' });
    expect(parseFayda('https://example.com')).toEqual({ ok: false, reason: 'NOT_FAYDA' });
    expect(parseFayda(card({ fields: 'V:5:G:F:A:6140123412341234:D:2002/11/26' }))).toMatchObject({ ok: false, reason: 'UNSUPPORTED_VERSION', version: '5' });
  });

  it('drops invalid dates and ID numbers instead of trusting them', () => {
    const r = parseFayda(card({ fields: 'V:4:G:X:A:12AB:D:2002/02/30' }));
    expect(r.ok && r.card).toMatchObject({ gender: null, fan: null, dateOfBirth: null });
  });
});

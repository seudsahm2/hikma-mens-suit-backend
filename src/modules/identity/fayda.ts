/**
 * Fayda (Ethiopian national ID) QR code: parse + verify, offline.
 *
 * Ported from the MIT-licensed `fayda_decoder` Dart package
 * (https://github.com/daveragos/fayda_decoder, © 2026 Alpha-Mintamir and fayda-decoder contributors).
 *
 * QR text (card format V4):
 *   <base64url WebP face>:DLT:<full name>:V:<version>:G:<M|F>:A:<FAN>:D:<yyyy/mm/dd>:SIGN:<JWS>
 * The JWS is DETACHED and RS256: header..signature, signed over
 *   base64url(header) + "." + base64url(UTF-8(everything before the last ":SIGN:"))
 * checked against NIDP's V4 public key (pinned below; SPKI SHA-256 fingerprint
 * 803dcd26057edc1423a5b9655f03c945b84a146be28caa754bc460a3fea6624a).
 */
import { createHash, createPublicKey, verify as rsaVerify, type KeyObject } from 'node:crypto';

export const FAYDA_V4_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxMWfApFZBq/qIotUjrkY
bdyXQcHOUgZsqZy3QUcXr50t+DfwYKkSfMnTZFHekptAWA4HM5upav6xqFuP+3Pi
KmajY2Imkl60bF4Bt9qcch74jPSObH/1CE0xs75dqLb+CfoTG1+i4n3Fz5cN9Mxp
EGE7pmvIdYtaAUCoKA/cjQ5QY426ttp4EQcnh5vmyr1e7ur9LjqVVsurfefxlsR+
sRfB2RFuaEGrLO/75UeUSY2x1nTHzOvycWYaCve1YfunHkXA8JvUy73+b33ixIgw
QuqUkOuyKhytFr5l6N1gfjTvOOysclCH5o8jy7KyzgyK17kHXPAaKuxYXH9pGtAF
0wIDAQAB
-----END PUBLIC KEY-----`;
export const FAYDA_V4_KEY_FINGERPRINT = '803dcd26057edc1423a5b9655f03c945b84a146be28caa754bc460a3fea6624a';

const DLT = ':DLT:';
const SIGN = ':SIGN:';
const SUPPORTED = new Set(['4']);

export interface FaydaCard {
  fullName: string;
  gender: 'male' | 'female' | null;
  fan: string | null;
  /** yyyy-mm-dd */
  dateOfBirth: string | null;
  version: string;
  /** WebP bytes of the face (RIFF), when present */
  face: Buffer | null;
  /** the signed text (before the last :SIGN:) and the JWS */
  signedText: string;
  jws: string | null;
  fields: Record<string, string>;
}

export type FaydaParse = { ok: true; card: FaydaCard } | { ok: false; reason: 'NOT_FAYDA' | 'UNSUPPORTED_VERSION'; version?: string };

const b64urlStrict = (s: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  const unpadded = s.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  return Buffer.from(unpadded, 'base64url');
};
const b64urlNoPad = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function validDate(s: string): string | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  if (d < 1 || d > days) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseFayda(text: string): FaydaParse {
  const payload = text.trim();
  const dlt = payload.indexOf(DLT);
  if (dlt < 0 || !payload.includes(SIGN)) return { ok: false, reason: 'NOT_FAYDA' };
  const facePart = payload.slice(0, dlt);
  const rest = payload.slice(dlt + DLT.length);
  const signAt = rest.lastIndexOf(SIGN); // the LAST marker: an earlier stray one can't cut the fields
  const fieldsPart = rest.slice(0, signAt);
  const jws = rest.slice(signAt + SIGN.length).trim();
  const segments = fieldsPart.split(':');
  const fullName = (segments[0] ?? '').trim();
  if (!fullName) return { ok: false, reason: 'NOT_FAYDA' };
  const fields: Record<string, string> = {};
  for (let i = 1; i + 1 < segments.length; i += 2) fields[segments[i]!] = segments[i + 1]!;
  const version = fields.V ?? '';
  if (!SUPPORTED.has(version)) return { ok: false, reason: 'UNSUPPORTED_VERSION', version };

  const fanDigits = (fields.A ?? '').replace(/\s/g, '');
  const faceBytes = facePart ? b64urlStrict(facePart) : null;
  const face = faceBytes && faceBytes.length >= 4 && faceBytes.subarray(0, 4).toString('latin1') === 'RIFF' ? faceBytes : null;
  return {
    ok: true,
    card: {
      fullName,
      gender: fields.G === 'M' ? 'male' : fields.G === 'F' ? 'female' : null,
      fan: /^\d{10,20}$/.test(fanDigits) ? fanDigits : null,
      dateOfBirth: fields.D ? validDate(fields.D) : null,
      version,
      face,
      signedText: payload.slice(0, dlt + DLT.length + signAt),
      jws: jws || null,
      fields,
    },
  };
}

let bundled: KeyObject | null = null;
const v4Key = () => (bundled ??= createPublicKey(FAYDA_V4_PUBLIC_KEY_PEM));

export type FaydaVerify = { verified: true; fingerprint: string } | { verified: false; reason: 'NO_SIGNATURE' | 'MALFORMED_JWS' | 'UNSUPPORTED_ALGORITHM' | 'BAD_SIGNATURE' };

/** Checks the card's NIDP signature (RS256, detached JWS). `publicKeyPem` is for tests / a future key. */
export function verifyFayda(card: Pick<FaydaCard, 'signedText' | 'jws'>, publicKeyPem?: string): FaydaVerify {
  if (!card.jws) return { verified: false, reason: 'NO_SIGNATURE' };
  const parts = card.jws.split('.');
  if (parts.length !== 3 || !parts[0] || parts[1] !== '' || !parts[2]) return { verified: false, reason: 'MALFORMED_JWS' };
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { verified: false, reason: 'MALFORMED_JWS' };
  }
  if (!header || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'RS256') return { verified: false, reason: 'UNSUPPORTED_ALGORITHM' };
  const key = publicKeyPem ? createPublicKey(publicKeyPem) : v4Key();
  const signingInput = `${parts[0]}.${b64urlNoPad(Buffer.from(card.signedText, 'utf8'))}`;
  const ok = rsaVerify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) return { verified: false, reason: 'BAD_SIGNATURE' };
  return { verified: true, fingerprint: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') };
}

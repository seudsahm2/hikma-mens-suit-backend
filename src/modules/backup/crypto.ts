/**
 * Backup encryption: AES-256-GCM with a key derived (scrypt, random salt per file) from the
 * BACKUP_KEY passphrase. GCM also authenticates: a damaged or tampered file fails to open instead
 * of restoring wrong data.
 *
 * File layout: "HKB1" | salt(16) | iv(12) | tag(16) | ciphertext
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('HKB1');

export const MIN_KEY_LENGTH = 16;

function keyFrom(passphrase: string, salt: Buffer) {
  if (passphrase.length < MIN_KEY_LENGTH) throw new Error(`BACKUP_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Hikma backup file');
  const salt = data.subarray(4, 20);
  const iv = data.subarray(20, 32);
  const tag = data.subarray(32, 48);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
  } catch {
    throw new Error('Wrong BACKUP_KEY or damaged file');
  }
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

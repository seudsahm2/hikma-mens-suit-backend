/**
 * Writes an encrypted database backup to a local file (same format as the Telegram backups).
 *   ENV_FILE=.env.xxx npx tsx src/scripts/backupToFile.ts [folder]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { encrypt } from '../modules/backup/crypto';
import { PART_BYTES } from '../modules/backup/backup.service';
import { createSnapshot } from '../modules/backup/snapshot';

(async () => {
  if (!env.BACKUP_KEY) throw new Error('BACKUP_KEY is not set');
  const dir = path.resolve(process.argv[2] ?? 'backups');
  mkdirSync(dir, { recursive: true });
  const snap = await createSnapshot();
  const sealed = encrypt(snap.gz, env.BACKUP_KEY);
  const name = `hikma-db-${snap.createdAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z')}`;
  const parts = Math.ceil(sealed.length / PART_BYTES);
  for (let i = 0; i < parts; i++) {
    const file = path.join(dir, parts > 1 ? `${name}.part${i + 1}of${parts}.hkb` : `${name}.hkb`);
    writeFileSync(file, sealed.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
    console.log(file);
  }
  console.log(`${snap.rows} rows · schema ${snap.migration}`);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

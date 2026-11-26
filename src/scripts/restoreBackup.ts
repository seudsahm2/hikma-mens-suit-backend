/**
 * Restore a Hikma backup.
 *
 *   Database (into an EMPTY database that has the same migrations applied):
 *     ENV_FILE=.env.restore npx tsx src/scripts/restoreBackup.ts db <file.hkb> [more parts…] [--dry-run] [--replace] [--schema-newer-ok]
 *
 *   Files (put every backed-up file back at its original path, only the missing ones):
 *     ENV_FILE=.env.restore npx tsx src/scripts/restoreBackup.ts files [--dry-run]
 *
 * Download the .hkb file(s) from the backup chat in Telegram (all parts of one backup). The env file
 * must hold DATABASE_URL (target), BACKUP_KEY (the same passphrase), and for files the bot token +
 * storage settings.
 *
 * Safety:
 *   • nothing is written unless every check passes: passphrase, format, per-table row counts and
 *     checksums, and the target's schema version;
 *   • the target must be empty (or --replace, which empties it inside the same transaction);
 *   • the whole database restore is ONE transaction — it either completes fully or changes nothing;
 *   • rows keep their original ids and timestamps, so links, history and dates stay exactly as they were.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { getObject, putObject, writeImageAt } from '../lib/storage';
import { decodeRow } from '../modules/backup/codec';
import { decrypt, sha256 } from '../modules/backup/crypto';
import { appliedMigrations, delegateName, FORMAT, modelsInOrder } from '../modules/backup/snapshot';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (f: string) => args.includes(f);
const files = args.slice(1).filter((a) => !a.startsWith('--'));
const say = (s: string) => console.log(s);

function need<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null) {
    console.error(`✖ ${msg}`);
    process.exit(1);
  }
  return v;
}

/** "….part2of3.hkb" → put parts back in order; a single file has no part number. */
function partOrder(file: string) {
  const m = file.match(/part(\d+)of(\d+)/);
  return m ? { n: Number(m[1]), of: Number(m[2]) } : { n: 1, of: 1 };
}

async function restoreDb() {
  const key = need(env.BACKUP_KEY, 'BACKUP_KEY is not set in the env file');
  if (!files.length) need(null, 'Give the backup file(s): … db hikma-db-…hkb');
  const sorted = [...files].sort((a, b) => partOrder(a).n - partOrder(b).n);
  const of = partOrder(sorted[0]!).of;
  if (sorted.length !== of || sorted.some((f, i) => partOrder(f).n !== i + 1)) need(null, `This backup has ${of} part(s) — give all of them (got ${sorted.length})`);

  say(`• Reading ${sorted.length} file(s)…`);
  const plain = gunzipSync(decrypt(Buffer.concat(sorted.map((f) => readFileSync(f))), key));
  const lines = plain.toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]!);
  const footer = JSON.parse(lines[lines.length - 1]!);
  if (header.type !== 'header' || header.format !== FORMAT) need(null, `Unknown backup format (${header.format})`);
  if (footer.type !== 'footer') need(null, 'The backup is incomplete (no footer) — a part is missing or cut');
  say(`• Backup of ${header.createdAt} · schema ${header.migration}`);

  // Verify every table: row count + checksum must match what was written
  const byModel = new Map<string, string[]>();
  for (const line of lines.slice(1, -1)) {
    const t = line.slice(6, line.indexOf('"', 6)); // {"t":"Model",…
    if (!byModel.has(t)) byModel.set(t, []);
    byModel.get(t)!.push(line);
  }
  for (const [model, count] of Object.entries(footer.counts as Record<string, number>)) {
    const rows = byModel.get(model) ?? [];
    const h = createHash('sha256');
    for (const l of rows) h.update(l);
    if (rows.length !== count || h.digest('hex') !== footer.sha256[model]) need(null, `Table ${model} doesn't match its checksum — the file is damaged`);
  }
  say(`• Checksums OK for ${Object.keys(footer.counts).length} tables, ${lines.length - 2} rows`);

  // Target: same schema, empty
  // Same tables and columns = the same applied migrations
  const target = await appliedMigrations();
  const wanted: string[] = header.migrations ?? [header.migration];
  const missing = wanted.filter((m) => !target.includes(m));
  const extra = target.filter((m) => !wanted.includes(m));
  if (missing.length) need(null, `Target database is missing migrations the backup needs: ${missing.join(', ')}. Run "prisma migrate deploy" with the app version of that date first.`);
  if (extra.length && !flag('--schema-newer-ok'))
    need(null, `Target database has newer migrations (${extra.join(', ')}). Restore into the matching version, or add --schema-newer-ok (new columns get their defaults).`);
  if (extra.length) say(`! Target has ${extra.length} newer migration(s) — new columns get their defaults`);
  const models = modelsInOrder().filter((m) => header.models.includes(m.name));
  const notEmpty: string[] = [];
  for (const m of models) {
    const n = await (prisma as unknown as Record<string, { count: () => Promise<number> }>)[delegateName(m.name)]!.count();
    if (n) notEmpty.push(`${m.name} (${n})`);
  }
  if (notEmpty.length && !flag('--replace')) need(null, `Target is not empty: ${notEmpty.join(', ')}. Use an empty database, or --replace to empty it as part of the restore.`);

  if (flag('--dry-run')) {
    say('✓ Dry run: everything checks out. Nothing was written.');
    return;
  }

  say('• Restoring in one transaction…');
  await prisma.$transaction(
    async (tx) => {
      const d = (name: string) => (tx as unknown as Record<string, { deleteMany: () => Promise<unknown>; createMany: (a: { data: object[] }) => Promise<{ count: number }> }>)[delegateName(name)]!;
      if (notEmpty.length) for (const m of [...models].reverse()) await d(m.name).deleteMany();
      for (const m of models) {
        const jsonFields = m.fields.filter((f) => f.type === 'Json').map((f) => f.name);
        const rows = (byModel.get(m.name) ?? []).map((l) => {
          const row = decodeRow(JSON.parse(l).r);
          for (const f of jsonFields) if (row[f] === null) row[f] = Prisma.DbNull; // JSON columns need an explicit "no value"
          return row;
        });
        for (let i = 0; i < rows.length; i += 500) await d(m.name).createMany({ data: rows.slice(i, i + 500) });
        if (rows.length) say(`  ${m.name.padEnd(16)} ${rows.length}`);
      }
    },
    { timeout: 30 * 60_000, maxWait: 30_000 },
  );
  say('✓ Database restored. Next: `… files` to bring back photos that are missing from storage.');
}

async function restoreFiles() {
  const key = need(env.BACKUP_KEY, 'BACKUP_KEY is not set in the env file');
  const token = need(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN is needed to download files from Telegram');
  const list = await prisma.backupFile.findMany({ where: { removedAt: null, NOT: { path: { startsWith: 'orphan/' } } }, orderBy: { backedUpAt: 'asc' } });
  say(`• ${list.length} files in the backup ledger`);
  let restored = 0;
  let present = 0;
  for (const f of list) {
    const probe = f.kind === 'image' ? `${f.path}-lg.webp` : f.path;
    if (await getObject(probe)) {
      present++;
      continue;
    }
    if (flag('--dry-run')) {
      say(`  would restore ${f.path}`);
      continue;
    }
    const meta = (await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(f.fileId)}`)).json()) as { ok: boolean; result?: { file_path: string } };
    if (!meta.ok || !meta.result) {
      console.error(`  ✖ ${f.path}: Telegram can't find the file`);
      continue;
    }
    const sealed = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`)).arrayBuffer());
    const body = decrypt(sealed, key);
    if (sha256(body) !== f.sha256) {
      console.error(`  ✖ ${f.path}: checksum mismatch — skipped`);
      continue;
    }
    if (f.kind === 'image') await writeImageAt(f.path, body);
    else await putObject(f.path, body, f.path.endsWith('.mp4') ? 'video/mp4' : f.path.endsWith('.webp') ? 'image/webp' : 'application/octet-stream');
    restored++;
    say(`  ✓ ${f.path}`);
  }
  say(`✓ Files: ${restored} restored, ${present} already there.`);
}

(async () => {
  if (mode === 'db') await restoreDb();
  else if (mode === 'files') await restoreFiles();
  else say('Usage: restoreBackup.ts db <file.hkb…> [--dry-run] [--replace] [--schema-newer-ok]  |  restoreBackup.ts files [--dry-run]');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('✖ Restore failed — nothing was changed in the database.', err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});

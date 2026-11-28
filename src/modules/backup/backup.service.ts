/**
 * Backups to Telegram + safe storage cleanup.
 *
 *  • Database: a consistent snapshot every day (≈03:00 Addis) and on demand → encrypted → sent to the
 *    owner's Telegram in parts ≤ 19 MB (the bot can download them back for a restore).
 *  • Files: every stored file is copied once (encrypted) and recorded in BackupFile with its Telegram
 *    file id, so a restore puts it back at exactly the same path. New files are picked up every few minutes.
 *  • Cleanup never deletes anything that isn't safely backed up first, and always shows a preview.
 *
 * Restore: `npm run backup:restore` (src/scripts/restoreBackup.ts) — see docs in that file.
 */
import { InputFile } from 'grammy';
import { env } from '../../config/env';
import { conflict, HttpError } from '../../lib/http';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { getObject, IMAGE_SIZES, listObjects, removeObjects } from '../../lib/storage';
import { bot } from '../telegram/bot';
import { getOwnerTopicId } from '../telegram/ownerChat';
import { encrypt, MIN_KEY_LENGTH, sha256 } from './crypto';
import { createSnapshot } from './snapshot';

export const PART_BYTES = 19 * 1024 * 1024; // bots can download files up to 20 MB
const DAY = 86_400_000;

// ─── Where / with what ───────────────────────────────────

export function backupReady(): { ok: true; key: string } | { ok: false; reason: string } {
  if (!bot) return { ok: false, reason: 'The Telegram bot is not set up on the server.' };
  if (!env.BACKUP_KEY || env.BACKUP_KEY.length < MIN_KEY_LENGTH)
    return { ok: false, reason: `Set BACKUP_KEY (a passphrase of ${MIN_KEY_LENGTH}+ characters) in the server settings, and keep a copy somewhere safe.` };
  return { ok: true, key: env.BACKUP_KEY };
}

/** The owner's own Telegram (private) unless BACKUP_CHAT_ID says otherwise. */
export async function backupChat(): Promise<string | null> {
  if (env.BACKUP_CHAT_ID) return env.BACKUP_CHAT_ID;
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true, staffTelegramId: { not: null } }, orderBy: { createdAt: 'asc' } });
  return owner?.staffTelegramId?.toString() ?? null;
}

async function prepare() {
  const ready = backupReady();
  if (!ready.ok) throw new HttpError(503, ready.reason, 'BACKUP_NOT_READY');
  const chat = await backupChat();
  if (!chat) throw new HttpError(503, 'Connect your Telegram first (Settings → Telegram → You) — backups are sent there.', 'BACKUP_NO_CHAT');
  return { key: ready.key, chat };
}

const stamp = (iso: string) => iso.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');

// ─── Database ────────────────────────────────────────────

let dbRunning = false;

export async function runDbBackup(trigger: 'daily' | 'manual') {
  if (dbRunning) throw conflict('A backup is already running', 'BACKUP_RUNNING');
  const { key, chat } = await prepare();
  dbRunning = true;
  const run = await prisma.backupRun.create({ data: { kind: 'db', trigger } });
  try {
    const snap = await createSnapshot();
    const sealed = encrypt(snap.gz, key);
    const parts: Buffer[] = [];
    for (let i = 0; i < sealed.length; i += PART_BYTES) parts.push(sealed.subarray(i, i + PART_BYTES));
    const name = `hikma-db-${stamp(snap.createdAt)}`;
    const messages: string[] = [];
    const topicId = await getOwnerTopicId(chat);
    for (const [i, part] of parts.entries()) {
      const file = parts.length > 1 ? `${name}.part${i + 1}of${parts.length}.hkb` : `${name}.hkb`;
      const caption = [
        `🗄 Database backup · ${new Date(snap.createdAt).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa', dateStyle: 'medium', timeStyle: 'short' })}`,
        `${snap.rows.toLocaleString('en-US')} rows · schema ${snap.migration ?? '?'}`,
        parts.length > 1 ? `Part ${i + 1} of ${parts.length}` : '',
        `sha256 ${sha256(sealed).slice(0, 16)}…`,
        'Encrypted — opens only with BACKUP_KEY. Keep this chat.',
      ]
        .filter(Boolean)
        .join('\n');
      const msg = await bot!.api.sendDocument(chat, new InputFile(part, file), {
        caption,
        disable_notification: trigger === 'daily',
        ...(topicId ? { message_thread_id: topicId } : {}),
      });
      messages.push(`${chat}:${msg.message_id}:${msg.document?.file_id ?? ''}`);
    }
    return await prisma.backupRun.update({
      where: { id: run.id },
      data: { status: 'ok', finishedAt: new Date(), rows: snap.rows, bytes: sealed.length, parts: parts.length, migration: snap.migration, sha256: sha256(sealed), messages },
    });
  } catch (err) {
    logger.error({ err }, 'database backup failed');
    await prisma.backupRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), note: (err as Error).message.slice(0, 500) } });
    throw err;
  } finally {
    dbRunning = false;
  }
}

// ─── Files ───────────────────────────────────────────────

/** Object path in the public URL we stored (hero video / image), or null if it isn't ours. */
function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/object\/public\/[^/]+\/(.+)$/) ?? url.match(/\/uploads\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}
const imageKeyOf = (objectPath: string) => objectPath.replace(/-(sm|md|lg)\.webp$/, '');

/** Every file the database points to: image keys (3 sizes each) and raw files. */
export async function referencedFiles() {
  const [pi, pp, rp, orders, items, settings] = await Promise.all([
    prisma.productImage.findMany({ select: { key: true } }),
    prisma.proofPhoto.findMany({ select: { key: true } }),
    prisma.reviewPhoto.findMany({ select: { key: true } }),
    prisma.order.findMany({ where: { paymentProofKey: { not: null } }, select: { paymentProofKey: true } }),
    prisma.orderItem.findMany({ where: { imageKey: { not: null } }, select: { imageKey: true } }),
    prisma.settings.findUnique({ where: { id: 'default' }, select: { heroVideoUrl: true, heroImageUrl: true } }),
  ]);
  const images = new Set<string>([...pi.map((x) => x.key), ...pp.map((x) => x.key), ...rp.map((x) => x.key), ...orders.map((x) => x.paymentProofKey!), ...items.map((x) => x.imageKey!)]);
  const raw = new Set<string>();
  for (const u of [settings?.heroVideoUrl, settings?.heroImageUrl]) {
    const p = pathFromUrl(u);
    if (!p) continue;
    if (/-(sm|md|lg)\.webp$/.test(p)) images.add(imageKeyOf(p));
    else raw.add(p);
  }
  return { images, raw };
}

let filesRunning = false;

/** Copies up to `limit` files that aren't in Telegram yet. Returns how many were copied. */
export async function runFileBackup(limit = 20, trigger: 'daily' | 'manual' = 'daily') {
  if (filesRunning) return 0;
  const ready = backupReady();
  const chat = await backupChat();
  if (!ready.ok || !chat) return 0;
  filesRunning = true;
  try {
    const { images, raw } = await referencedFiles();
    const known = new Set((await prisma.backupFile.findMany({ select: { path: true } })).map((f) => f.path));
    const todo = [...[...images].map((p) => ({ path: p, kind: 'image' as const })), ...[...raw].map((p) => ({ path: p, kind: 'raw' as const }))]
      .filter((f) => !known.has(f.path))
      .slice(0, limit);
    const topicId = await getOwnerTopicId(chat);
    let done = 0;
    for (const f of todo) {
      // Images: the largest size is kept; the smaller ones are rebuilt from it on restore
      const body = await getObject(f.kind === 'image' ? `${f.path}-lg.webp` : f.path);
      if (!body) continue; // missing in storage — nothing to copy (reported in the storage page)
      if (body.length > 45 * 1024 * 1024) {
        logger.warn({ path: f.path, size: body.length }, 'file too large for a Telegram backup — skipped');
        continue;
      }
      const sealed = encrypt(body, ready.key);
      const msg = await bot!.api.sendDocument(chat, new InputFile(sealed, `${f.path.replace(/\//g, '__')}.hkb`), {
        caption: `🖼 ${f.path}`,
        disable_notification: true,
        ...(topicId ? { message_thread_id: topicId } : {}),
      });
      await prisma.backupFile.create({
        data: { path: f.path, kind: f.kind, size: body.length, sha256: sha256(body), chatId: chat, messageId: msg.message_id, fileId: msg.document!.file_id },
      });
      done++;
      await new Promise((r) => setTimeout(r, 1100)); // ~1 message/second to one chat
    }
    if (done && trigger === 'manual') await prisma.backupRun.create({ data: { kind: 'files', trigger, status: 'ok', finishedAt: new Date(), files: done } });
    return done;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'file backup batch failed');
    return 0;
  } finally {
    filesRunning = false;
  }
}

// ─── Status / storage report ─────────────────────────────

export async function backupStatus() {
  const ready = backupReady();
  const [chat, lastDb, lastOk, runs, files, refs] = await Promise.all([
    backupChat(),
    prisma.backupRun.findFirst({ where: { kind: 'db' }, orderBy: { startedAt: 'desc' } }),
    prisma.backupRun.findFirst({ where: { kind: 'db', status: 'ok' }, orderBy: { startedAt: 'desc' } }),
    prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: 15 }),
    prisma.backupFile.aggregate({ _count: true, _sum: { size: true } }),
    referencedFiles(),
  ]);
  const totalFiles = refs.images.size + refs.raw.size;
  return {
    ready: ready.ok,
    reason: ready.ok ? null : ready.reason,
    chatConnected: Boolean(chat),
    lastDb,
    lastOkAt: lastOk?.finishedAt ?? null,
    files: { backedUp: files._count, total: totalFiles, bytes: files._sum.size ?? 0 },
    runs: runs.map((r) => ({ ...r, messages: undefined })),
  };
}

export async function storageReport() {
  const [objects, refs, dbSize, tables] = await Promise.all([
    listObjects(),
    referencedFiles(),
    prisma.$queryRawUnsafe<{ size: bigint }[]>('SELECT pg_database_size(current_database()) AS size'),
    prisma.$queryRawUnsafe<{ name: string; size: bigint; rows: bigint }[]>(
      `SELECT relname AS name, pg_total_relation_size(relid) AS size, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 12`,
    ),
  ]);
  const folders: Record<string, { files: number; bytes: number }> = {};
  for (const o of objects) {
    const f = o.path.split('/')[0] ?? '';
    folders[f] ??= { files: 0, bytes: 0 };
    folders[f].files++;
    folders[f].bytes += o.size;
  }
  const orphans = findOrphans(objects, refs);
  return {
    database: { bytes: Number(dbSize[0]?.size ?? 0), tables: tables.map((t) => ({ name: t.name, bytes: Number(t.size), rows: Number(t.rows) })) },
    storage: { files: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0), folders },
    orphans: { files: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0) },
  };
}

/** Stored files nothing points to (replaced/deleted photos), older than a day (never an upload in progress). */
function findOrphans(objects: { path: string; size: number; updatedAt: Date }[], refs: { images: Set<string>; raw: Set<string> }) {
  const cutoff = Date.now() - DAY;
  return objects.filter((o) => {
    if (o.updatedAt.getTime() > cutoff) return false;
    if (refs.raw.has(o.path)) return false;
    if (/-(sm|md|lg)\.webp$/.test(o.path) && refs.images.has(imageKeyOf(o.path))) return false;
    return true;
  });
}

// ─── Cleanup (preview → apply) ───────────────────────────

/**
 * What can go, safely:
 *  • orphan files (nothing points to them; older than a day)
 *  • short-lived records past their use: expired sign-in links, used/expired link codes, old bag
 *    snapshots (60 d), Telegram card bookkeeping of finished orders (30 d), sent announcements (90 d),
 *    activity log older than 12 months.
 * Orders, payments, stock history, customers, reviews and products are never cleaned.
 * Applying requires a database backup from the last 24 hours (so everything removed is in a backup).
 */
function cleanupRules() {
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY);
  return [
    { id: 'loginTokens', label: 'Expired sign-in links', count: () => prisma.loginToken.count({ where: { expiresAt: { lt: new Date() } } }), apply: () => prisma.loginToken.deleteMany({ where: { expiresAt: { lt: new Date() } } }) },
    { id: 'linkCodes', label: 'Expired Telegram link codes', count: () => prisma.linkCode.count({ where: { expiresAt: { lt: new Date() } } }), apply: () => prisma.linkCode.deleteMany({ where: { expiresAt: { lt: new Date() } } }) },
    { id: 'carts', label: 'Bag snapshots untouched for 60 days', count: () => prisma.cartSnapshot.count({ where: { updatedAt: { lt: ago(60) } } }), apply: () => prisma.cartSnapshot.deleteMany({ where: { updatedAt: { lt: ago(60) } } }) },
    {
      id: 'cards',
      label: 'Telegram card bookkeeping of orders finished 30+ days ago',
      count: () => prisma.adminCard.count({ where: { order: { status: { in: ['DELIVERED', 'PICKED_UP', 'CANCELLED'] }, updatedAt: { lt: ago(30) } } } }),
      apply: () => prisma.adminCard.deleteMany({ where: { order: { status: { in: ['DELIVERED', 'PICKED_UP', 'CANCELLED'] }, updatedAt: { lt: ago(30) } } } }),
    },
    { id: 'broadcasts', label: 'Finished announcements older than 90 days', count: () => prisma.broadcast.count({ where: { status: { not: 'sending' }, createdAt: { lt: ago(90) } } }), apply: () => prisma.broadcast.deleteMany({ where: { status: { not: 'sending' }, createdAt: { lt: ago(90) } } }) },
    { id: 'activity', label: 'Activity log older than 12 months', count: () => prisma.activityLog.count({ where: { createdAt: { lt: ago(365) } } }), apply: () => prisma.activityLog.deleteMany({ where: { createdAt: { lt: ago(365) } } }) },
  ];
}

export async function cleanupPreview() {
  const [rules, objects, refs] = await Promise.all([
    Promise.all(cleanupRules().map(async (r) => ({ id: r.id, label: r.label, rows: await r.count() }))),
    listObjects(),
    referencedFiles(),
  ]);
  const orphans = findOrphans(objects, refs);
  const lastOk = await prisma.backupRun.findFirst({ where: { kind: 'db', status: 'ok' }, orderBy: { startedAt: 'desc' } });
  return {
    records: rules,
    orphanFiles: { files: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0), sample: orphans.slice(0, 5).map((o) => o.path) },
    backupFresh: Boolean(lastOk && lastOk.finishedAt && Date.now() - lastOk.finishedAt.getTime() < DAY),
    lastBackupAt: lastOk?.finishedAt ?? null,
  };
}

export async function cleanupApply(actorId: string | null) {
  const lastOk = await prisma.backupRun.findFirst({ where: { kind: 'db', status: 'ok' }, orderBy: { startedAt: 'desc' } });
  if (!lastOk?.finishedAt || Date.now() - lastOk.finishedAt.getTime() > DAY)
    throw conflict('Make a database backup first (“Back up now”) — cleanup only runs right after a fresh backup', 'BACKUP_FIRST');
  const removed: Record<string, number> = {};
  for (const r of cleanupRules()) removed[r.id] = (await r.apply()).count;
  // Orphan files: copy each to Telegram first, then delete from storage
  const { key, chat } = await prepare();
  const orphans = findOrphans(await listObjects(), await referencedFiles());
  let files = 0;
  for (const o of orphans) {
    const body = await getObject(o.path);
    if (!body) continue;
    const already = await prisma.backupFile.findUnique({ where: { path: `orphan/${o.path}` } });
    if (!already) {
      const msg = await bot!.api.sendDocument(chat, new InputFile(encrypt(body, key), `orphan__${o.path.replace(/\//g, '__')}.hkb`), { caption: `🗑 removed from storage: ${o.path}`, disable_notification: true });
      await prisma.backupFile.create({
        data: { path: `orphan/${o.path}`, kind: 'raw', size: body.length, sha256: sha256(body), chatId: chat, messageId: msg.message_id, fileId: msg.document!.file_id, removedAt: new Date() },
      });
      await new Promise((r) => setTimeout(r, 1100));
    }
    await removeObjects([o.path]);
    files++;
  }
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  await prisma.backupRun.create({ data: { kind: 'cleanup', trigger: 'manual', status: 'ok', finishedAt: new Date(), rows: total, files, note: JSON.stringify(removed) } });
  logger.info({ removed, files, actorId }, 'storage cleanup');
  return { removed, files };
}

// ─── Schedule ────────────────────────────────────────────

/** Daily database backup after 03:00 Addis (00:00 UTC) + new files every few minutes. */
export function startBackupWorker() {
  if (!bot) return () => undefined;
  const tick = async () => {
    try {
      const now = new Date();
      // A job left 'running' by a restart (Render sleeps/redeploys) is marked failed, so it never blocks the next one
      await prisma.backupRun.updateMany({ where: { status: 'running', startedAt: { lt: new Date(Date.now() - 60 * 60_000) } }, data: { status: 'failed', finishedAt: new Date(), note: 'Interrupted (server restarted)' } });
      // Once per UTC day (00:00 UTC = 03:00 Addis); a sleeping server catches up when it wakes
      if (backupReady().ok && (await backupChat())) {
        const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const today = await prisma.backupRun.findFirst({ where: { kind: 'db', trigger: 'daily', status: { in: ['ok', 'running'] }, startedAt: { gte: since } } });
        if (!today && !dbRunning) await runDbBackup('daily').catch(() => undefined);
      }
      await runFileBackup(20);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'backup worker tick failed');
    }
  };
  const first = setTimeout(tick, 60_000);
  const id = setInterval(tick, 5 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(id);
  };
}

export const IMAGE_RENDITIONS = Object.keys(IMAGE_SIZES);

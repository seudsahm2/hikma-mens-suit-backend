/**
 * Imports products from the shop's Telegram channel export (Telegram Desktop → JSON + photos).
 *
 *   npm run import:telegram -- [path/to/result.json] [options]
 *
 * Default path: ../docs/reference/telegram/export/result.json
 *
 * Each post (album photos + caption) becomes a product. Price, brand, origin, sizes and category
 * are read from the caption; greetings/announcements are skipped. Re-running skips posts that
 * were already imported, so it is safe to run again after a newer export.
 *
 * Options
 *   --dry-run                 print what would be imported, change nothing
 *   --since=YYYY-MM-DD        ignore posts older than this date
 *   --activate-since=DATE     posts on/after DATE go on sale (with placeholder stock); older ones stay DRAFT
 *   --activate                put every priced post on sale (placeholder stock)
 *   --stock=N                 placeholder stock per size when activating (default 1)
 *
 * Placeholder stock is only for showing the catalogue; the owner sets real stock per size in the
 * dashboard (Products → product → Sizes, colours & stock).
 */
import '../config/loadEnv';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Category } from '@prisma/client';
import { saveImage } from '../lib/storage';
import { randomSuffix, slugify } from '../lib/slug';
import { BRANDS, parseCaption } from '../modules/catalog/captionParser';

// ─── Export format ───────────────────────────────────────

type TextPart = string | { type: string; text: string };
interface TgMessage {
  id: number;
  type: string;
  date: string;
  date_unixtime?: string;
  photo?: string;
  file?: string;
  mime_type?: string;
  media_type?: string;
  text?: string | TextPart[];
}

export const captionText = (t: TgMessage['text']) =>
  Array.isArray(t) ? t.map((p) => (typeof p === 'string' ? p : p.text)).join('') : (t ?? '');
const unix = (m: TgMessage) => Number(m.date_unixtime ?? Date.parse(m.date) / 1000);

export interface Post {
  id: number;
  date: string;
  caption: string;
  photos: string[];
}

/**
 * Album photos arrive as separate messages within a few seconds; the caption sits on one of them.
 * A new post starts when there is a time gap or when a second caption appears.
 */
export function groupPosts(messages: TgMessage[]): Post[] {
  const posts: (Post & { t: number })[] = [];
  let current: (Post & { t: number }) | null = null;
  for (const m of messages) {
    if (m.type !== 'message') continue;
    const photo = m.photo ?? (m.mime_type?.startsWith('image/') ? m.file : undefined);
    const caption = captionText(m.text).trim();
    if (!photo && !caption) continue;
    const t = unix(m);
    const sameAlbum = current !== null && t - current.t <= 5 && !(caption && current.caption);
    if (sameAlbum && current) {
      if (photo) current.photos.push(photo);
      if (caption) current.caption = caption;
      current.t = t;
    } else {
      if (current) posts.push(current);
      current = { id: m.id, date: m.date, caption, photos: photo ? [photo] : [], t };
    }
  }
  if (current) posts.push(current);
  return posts.map(({ t: _t, ...p }) => p).filter((p) => p.photos.length > 0);
}

// Caption parsing lives in src/modules/catalog/captionParser.ts (shared with the live channel import)
export { parseCaption, type Parsed } from '../modules/catalog/captionParser';

// ─── Import ──────────────────────────────────────────────

function option(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const exportPath = path.resolve(argv.find((a) => !a.startsWith('--')) ?? path.join(__dirname, '../../../docs/reference/telegram/export/result.json'));
  const exportDir = path.dirname(exportPath);
  const dryRun = flags.has('--dry-run');
  const since = option('since') ? new Date(option('since')!) : null;
  const activateSince = option('activate-since') ? new Date(option('activate-since')!) : null;
  const activateAll = flags.has('--activate');
  const stock = Math.max(1, Number(option('stock') ?? 1));

  if (!existsSync(exportPath)) {
    console.error(`✗ Export not found: ${exportPath}\n  Place Telegram's result.json (and its photos/ folder) there, or pass a path.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(exportPath, 'utf8')) as { name?: string; messages: TgMessage[] };
  const posts = groupPosts(data.messages).filter((p) => !since || new Date(p.date) >= since);
  console.log(`Channel: ${data.name ?? '?'} · ${data.messages.length} messages · ${posts.length} photo posts${since ? ` since ${option('since')}` : ''}\n`);

  // Optional hand-made classification (post id → [category, name, brand?]); see docs/reference/telegram/overrides.json
  const overridesPath = path.resolve(option('overrides') ?? path.join(exportDir, '..', 'overrides.json'));
  const overrides: Record<string, [string, string, string?] | null> = existsSync(overridesPath)
    ? JSON.parse(readFileSync(overridesPath, 'utf8'))
    : {};
  if (existsSync(overridesPath)) console.log(`Using overrides: ${overridesPath}\n`);

  const prisma = new PrismaClient();
  const categories = new Map<string, Category>((await prisma.category.findMany()).map((c) => [c.slug, c]));
  if (!categories.size) {
    console.error('✗ No categories. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const stats = { created: 0, active: 0, activated: 0, repaired: 0, skipped: 0, notProduct: 0, noCaption: 0 };
  const byCategory = new Map<string, number>();

  for (const post of posts) {
    if (!post.caption) {
      stats.noCaption++;
      continue; // loose photos without any text: nothing to name or price
    }
    const parsed = parseCaption(post.caption);
    const override = overrides[String(post.id)];
    if (override === null || (!override && !parsed.isProduct)) {
      stats.notProduct++;
      continue;
    }
    if (override) {
      const [slug, name, brandName] = override;
      parsed.categorySlug = slug;
      parsed.name = name;
      parsed.brand = brandName ?? BRANDS.find(([, re]) => re.test(name))?.[0] ?? null;
    }
    // The brand is shown as a label above the name, so don't repeat it: "Skechers Slip-Ins" → "Slip-Ins"
    if (parsed.brand && parsed.name.toLowerCase().startsWith(parsed.brand.toLowerCase() + ' ')) {
      parsed.name = parsed.name.slice(parsed.brand.length).trim();
    }
    const importRef = `tg-${post.id}`;
    const category = categories.get(parsed.categorySlug) ?? categories.get('shirts')!;
    const postDate = new Date(post.date);
    const activate = parsed.price !== null && (activateAll || (activateSince !== null && postDate >= activateSince));
    const line = `#${post.id} ${post.date.slice(0, 10)} · ${parsed.name} · ${parsed.price ?? '?'} ETB · ${category.slug} · ${post.photos.length} photo(s)${activate ? ' · ON SALE' : ''}`;

    const existing = await withRetry(() =>
      prisma.product.findUnique({ where: { importRef }, include: { _count: { select: { images: true } }, variants: true } }),
    );
    if (existing) {
      // An earlier run was interrupted while saving this product's photos: rebuild it
      if (existing._count.images === 0 && post.photos.length > 0 && existing.tags.includes('imported')) {
        if (dryRun) {
          console.log(`  ↻ ${line} (rebuild: no photos)`);
          stats.repaired++;
          continue;
        }
        await withRetry(() => prisma.product.delete({ where: { id: existing.id } }));
        stats.repaired++;
      } else if (activate && existing.status === 'DRAFT' && existing.tags.includes('imported')) {
        // Imported earlier as a draft and untouched since: put it on sale now
        const untouched = existing.variants.every((v) => v.stock === 0);
        if (!untouched) {
          stats.skipped++;
          continue;
        }
        if (!dryRun) {
          await withRetry(() =>
            prisma.$transaction([
              prisma.productVariant.updateMany({ where: { productId: existing.id, stock: 0 }, data: { stock } }),
              prisma.product.update({ where: { id: existing.id }, data: { status: 'ACTIVE' } }),
            ]),
          );
        }
        stats.activated++;
        console.log(`  ↑ ${line} (now on sale)`);
        continue;
      } else {
        stats.skipped++;
        continue;
      }
    }

    byCategory.set(category.slug, (byCategory.get(category.slug) ?? 0) + 1);
    if (dryRun) {
      console.log(`  ${line}`);
      stats.created++;
      if (activate) stats.active++;
      continue;
    }

    // 1) Upload photos first. 2) Create the product, variants and image rows in ONE database call,
    // so a dropped connection can never leave a half-created product behind.
    const images: { key: string; width: number | null; height: number | null; sortOrder: number; alt: string }[] = [];
    for (const rel of post.photos.slice(0, 10)) {
      const file = path.join(exportDir, rel);
      if (!existsSync(file)) {
        console.warn(`    ! missing photo ${rel}`);
        continue;
      }
      const buffer = await readFile(file);
      const saved = await withRetry(() => saveImage(buffer, 'products'));
      images.push({ key: saved.key, width: saved.width, height: saved.height, sortOrder: images.length, alt: parsed.name });
    }

    const brand = parsed.brand
      ? await withRetry(() =>
          prisma.brand.upsert({ where: { slug: slugify(parsed.brand!) }, create: { slug: slugify(parsed.brand!), name: parsed.brand! }, update: {} }),
        )
      : null;
    // Sizes: from the caption if listed, else the category's common sizes
    const sizes = parsed.sizes.length ? parsed.sizes : category.sizes.length ? category.sizes.slice(1, Math.min(category.sizes.length - 1, 6)) : [''];

    await withRetry(() =>
      prisma.product.create({
        data: {
          slug: `${slugify(parsed.name) || 'item'}-${randomSuffix(5)}`,
          importRef,
          nameEn: parsed.name,
          categoryId: category.id,
          brandId: brand?.id,
          origin: parsed.origin,
          basePrice: parsed.price ?? 0,
          status: activate ? 'ACTIVE' : 'DRAFT',
          isNewArrival: postDate > new Date(Date.now() - 60 * 86400_000),
          tags: ['imported'],
          createdAt: postDate,
          images: { create: images },
          variants: {
            create: sizes.map((size, i) => ({
              sku: `TG${post.id}-${i}-${randomSuffix(3).toUpperCase()}`,
              size,
              stock: activate ? stock : 0,
            })),
          },
        },
      }),
    );
    stats.created++;
    if (activate) stats.active++;
    console.log(`  + ${line}`);
  }

  console.log(
    `\n✓ ${dryRun ? 'DRY RUN — nothing was changed. Would import' : 'Imported'} ${stats.created} new products (${stats.active} on sale, ${stats.created - stats.active} drafts)` +
      `\n  ${stats.activated} earlier drafts put on sale · ${stats.repaired} rebuilt (missing photos) · ${stats.skipped} already imported` +
      `\n  ${stats.notProduct} greetings/announcements skipped · ${stats.noCaption} photos without text` +
      (byCategory.size ? `\n  new by category: ${[...byCategory].map(([k, v]) => `${k} ${v}`).join(', ')}` : ''),
  );
  await prisma.$disconnect();
}

/** Retries temporary network/database errors (dropped pooler connections, timeouts) with backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const transient =
        ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(e.code ?? '') ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|Can't reach database/i.test(e.message ?? '');
      if (!transient || i >= attempts) throw err;
      const wait = 2000 * 2 ** (i - 1);
      console.warn(`    … connection problem, retrying in ${wait / 1000}s (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

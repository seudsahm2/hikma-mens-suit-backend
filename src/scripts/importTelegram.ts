/**
 * Imports products from a Telegram Desktop channel export (JSON + photos).
 *
 *   npm run import:telegram -- [path/to/result.json] [--dry-run] [--activate]
 *
 * Default path: ../docs/reference/telegram/export/result.json
 *
 * Each post (a caption plus its album photos) becomes a DRAFT product. The script reads the
 * price, brand line and "Made in …" origin from the caption; the owner then checks names,
 * category, sizes and stock in the dashboard. Re-running skips posts that were already imported.
 *
 *   --dry-run   print what would be imported, change nothing
 *   --activate  create sizes from the category with stock 1 and publish (for demos only)
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Category } from '@prisma/client';
import { saveImage } from '../lib/storage';
import { randomSuffix, slugify } from '../lib/slug';

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const exportPath = path.resolve(argv.find((a) => !a.startsWith('--')) ?? path.join(__dirname, '../../../docs/reference/telegram/export/result.json'));
const exportDir = path.dirname(exportPath);

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
  text?: string | TextPart[];
}

const toText = (t: TgMessage['text']) => (Array.isArray(t) ? t.map((p) => (typeof p === 'string' ? p : p.text)).join('') : (t ?? ''));
const unix = (m: TgMessage) => Number(m.date_unixtime ?? Date.parse(m.date) / 1000);

interface Post {
  id: number;
  date: string;
  caption: string;
  photos: string[];
}

/** Album photos arrive as separate messages with the same timestamp; the caption sits on one of them. */
function groupPosts(messages: TgMessage[]): Post[] {
  const posts: Post[] = [];
  let current: (Post & { t: number }) | null = null;
  for (const m of messages) {
    if (m.type !== 'message') continue;
    const photo = m.photo ?? (m.mime_type?.startsWith('image/') ? m.file : undefined);
    const caption = toText(m.text).trim();
    if (!photo && !caption) continue;
    const t = unix(m);
    const continues = current && photo && t - current.t <= 3 && !(caption && current.caption);
    if (continues && current) {
      if (photo) current.photos.push(photo);
      if (caption) current.caption = caption;
      current.t = t;
    } else {
      if (current) posts.push(current);
      current = { id: m.id, date: m.date, caption, photos: photo ? [photo] : [], t };
    }
  }
  if (current) posts.push(current);
  return posts.filter((p) => p.photos.length > 0);
}

// ─── Caption parsing ─────────────────────────────────────

const KNOWN_BRANDS = ['Skechers', 'Nike', 'Adidas', 'New Balance', 'Puma', 'Reebok', 'Converse', 'Vans', 'Timberland', 'Clarks', 'Lacoste', 'Tommy Hilfiger', 'Hugo Boss', 'Zara', 'Ibraq', 'Assaf', 'Lattafa', 'Rasasi', 'Ajmal', 'Armaf', 'Al Haramain', 'Gissah', 'Champion'];

interface Parsed {
  price: number | null;
  brand: string | null;
  origin: string | null;
  categorySlug: string;
  name: string;
}

export function parseCaption(caption: string): Parsed {
  const priceMatch = caption.match(/ዋጋ\s*[፡:]\s*([\d,.\s]+)\s*ብር/);
  const price = priceMatch ? Number(priceMatch[1]!.replace(/[^\d]/g, '')) || null : null;

  const originMatch = caption.match(/Made in\s+([A-Za-zü\s]+?)(?:\s*[^\w\s]|$)/m);
  const origin = originMatch ? originMatch[1]!.trim() : null;

  // Brand: first line, emojis stripped, matched against known brands (the body text is unreliable)
  const firstLine = (caption.split('\n').find((l) => l.trim()) ?? '').replace(/[^\p{L}\p{N}\s&'-]/gu, ' ').trim();
  const brand = KNOWN_BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(firstLine)) ?? null;

  const lower = caption.toLowerCase();
  let categorySlug = 'shirts';
  if (caption.includes('👟') || caption.includes('ጫማ') || (brand && ['Skechers', 'Nike', 'Adidas', 'New Balance', 'Puma', 'Reebok', 'Converse', 'Vans', 'Timberland', 'Clarks'].includes(brand))) categorySlug = 'shoes';
  else if (caption.includes('ሽቶ') || lower.includes('perfume') || lower.includes('parfum') || (brand && ['Ibraq', 'Assaf', 'Lattafa', 'Rasasi', 'Ajmal', 'Armaf', 'Al Haramain', 'Gissah'].includes(brand))) categorySlug = 'perfumes';
  else if (lower.includes('suit') || caption.includes('ሱፍ') || (price !== null && price >= 15000)) categorySlug = 'suits';
  else if (lower.includes('jean') || caption.includes('ሱሪ')) categorySlug = 'jeans';
  else if (lower.includes('polo')) categorySlug = 'polos';
  else if (lower.includes('jacket') || caption.includes('ጃኬት')) categorySlug = 'jackets';

  const kindName: Record<string, string> = { shoes: 'Sneakers', perfumes: 'Perfume', suits: 'Suit', jeans: 'Jeans', polos: 'Polo', jackets: 'Jacket', shirts: 'Shirt' };
  const name = [brand ?? (origin ? `${origin === 'Turkey' ? 'Turkish' : origin}` : null), kindName[categorySlug]].filter(Boolean).join(' ');
  return { price, brand, origin, categorySlug, name: name || 'New item' };
}

// ─── Import ──────────────────────────────────────────────

async function main() {
  if (!existsSync(exportPath)) {
    console.error(`✗ Export not found: ${exportPath}\n  Place Telegram's result.json (and its photos/ folder) there, or pass a path.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(exportPath, 'utf8')) as { name?: string; messages: TgMessage[] };
  const posts = groupPosts(data.messages);
  console.log(`Channel: ${data.name ?? '?'} · ${data.messages.length} messages · ${posts.length} posts with photos\n`);

  const categories = new Map<string, Category>((await prisma.category.findMany()).map((c) => [c.slug, c]));
  let created = 0;
  let skipped = 0;

  for (const post of posts) {
    const parsed = parseCaption(post.caption);
    const importRef = `tg-${post.id}`;
    const line = `#${post.id} ${post.date.slice(0, 10)} · ${parsed.name} · ${parsed.price ?? '?'} ETB · ${parsed.categorySlug} · ${post.photos.length} photo(s)`;

    if (await prisma.product.findUnique({ where: { importRef } })) {
      skipped++;
      continue;
    }
    if (flags.has('--dry-run')) {
      console.log(`  ${line}`);
      continue;
    }

    const category = categories.get(parsed.categorySlug) ?? categories.get('shirts')!;
    const brand = parsed.brand
      ? await prisma.brand.upsert({ where: { slug: slugify(parsed.brand) }, create: { slug: slugify(parsed.brand), name: parsed.brand }, update: {} })
      : null;
    const slug = `${slugify(parsed.name)}-${randomSuffix(5)}`;
    const activate = flags.has('--activate') && parsed.price !== null;
    const sizes = category.sizes.length ? category.sizes.slice(1, -1) : [''];

    const product = await prisma.product.create({
      data: {
        slug,
        importRef,
        nameEn: parsed.name,
        categoryId: category.id,
        brandId: brand?.id,
        origin: parsed.origin,
        basePrice: parsed.price ?? 0,
        status: activate ? 'ACTIVE' : 'DRAFT',
        tags: ['imported'],
        createdAt: new Date(post.date),
        variants: activate
          ? { create: sizes.map((size, i) => ({ sku: `TG${post.id}-${i}-${randomSuffix(3).toUpperCase()}`, size, stock: 1 })) }
          : undefined,
      },
    });

    let order = 0;
    for (const rel of post.photos) {
      const file = path.join(exportDir, rel);
      if (!existsSync(file)) {
        console.warn(`    ! missing photo ${rel}`);
        continue;
      }
      const saved = await saveImage(await readFile(file), 'products');
      await prisma.productImage.create({
        data: { productId: product.id, key: saved.key, width: saved.width, height: saved.height, sortOrder: order++, alt: parsed.name },
      });
    }
    created++;
    console.log(`  + ${line}`);
  }

  console.log(`\n✓ ${flags.has('--dry-run') ? 'dry run' : `${created} imported`}, ${skipped} already imported`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

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
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Category } from '@prisma/client';
import { saveImage } from '../lib/storage';
import { randomSuffix, slugify } from '../lib/slug';

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

// ─── Caption parsing ─────────────────────────────────────

/** Brand → default category (null = decide from the caption). */
const BRANDS: [name: string, pattern: RegExp, category: string | null][] = [
  ['Skechers', /skechers/i, 'shoes'],
  ['Nike', /\bnike\b/i, 'shoes'],
  ['Adidas', /adidas|አዲዳስ/i, 'shoes'],
  ['New Balance', /new\s*balance/i, 'shoes'],
  ['Puma', /\bpuma\b/i, 'shoes'],
  ['Aldo', /\baldo\b/i, 'shoes'],
  ['Timberland', /timberland/i, 'shoes'],
  ['Integral', /integral/i, 'jeans'],
  ['Tello', /\btello\b/i, 'jeans'],
  ['Jack Kevin', /jack\s*kevin/i, null],
  ['MCR', /\bmcr\b/i, null],
  ['Gant', /\bgant\b/i, null],
  ['Lacoste', /lacoste/i, null],
  ['Loro Piana', /lo[rw]a?\s*piana/i, null],
  ['Hermès', /herm[eè]s/i, null],
  ['Prada', /\bprada\b/i, null],
  ['Columbia', /columbia/i, 'jackets'],
  ['Champion', /champion/i, null],
  ['Ibraq', /ibraq/i, 'perfumes'],
  ['Arabian Oud', /arabian\s*oud/i, 'perfumes'],
  ['Yusuf Bhai', /yusuf\s*bhai/i, 'perfumes'],
  ['Mind Games', /mind\s*games/i, 'perfumes'],
  ['Assaf', /\bassaf\b/i, 'perfumes'],
  ['Lattafa', /lattafa/i, 'perfumes'],
  ['Under Armour', /under\s*armou?r/i, 'shoes'],
  ['Naviforce', /naviforce/i, 'accessories'],
  ['Sveston', /sveston/i, 'accessories'],
];

const CATEGORY_RULES: [slug: string, pattern: RegExp][] = [
  ['shoes', /👟|ጫማ|\bshoes?\b|sneaker|loafer/i],
  ['perfumes', /ሽቶ|ሽታ|መዓዛ|perfume|parfum|\boud\b|fragrance|cologne/i],
  ['accessories', /watch|ሰዓት|automatic|water\s*proof|\bbelt\b|wallet|ቀበቶ/i],
  ['suits', /\bsuit\b|ሱፍ|blazer|tuxedo|ኮት/i],
  ['jeans', /jean|\bjns\b|trouser|pants?\b|ሱሪ|chino/i],
  ['jackets', /jacket|ጃኬት|\bcoat\b|hoodie|bomber/i],
  ['knitwear', /sweater|ሹራብ|knit|cardigan|turtle/i],
  ['polos', /\bpolo\b|t-?shirt|ቲሸርት|\btee\b/i],
  ['shirts', /shmiz|shirt|ሸሚዝ|jelbya|jelabiya|ጀለቢያ/i],
];

const KIND_NAME: Record<string, string> = {
  shoes: 'Sneakers',
  perfumes: 'Perfume',
  accessories: 'Watch',
  suits: 'Suit',
  jeans: 'Jeans',
  jackets: 'Jacket',
  knitwear: 'Knitwear',
  polos: 'Polo',
  shirts: 'Shirt',
};

const SIZE_TOKENS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL'];
const SKIP = /ኢድ|eid|mubarak|ሙባረክ|በዓል|holiday|እንኳን|ደንበኞቻችን|announcement|ማሳሰቢያ/i;

export interface Parsed {
  price: number | null;
  brand: string | null;
  origin: string | null;
  categorySlug: string;
  name: string;
  sizes: string[];
  /** False for greetings / announcements without a price. */
  isProduct: boolean;
}

function parsePrice(caption: string): number | null {
  const labelled = caption.match(/(?:price|ዋጋ)\s*[.:፡\-]*\s*(\d[\d,.\s]{1,9}\d|\d{3,})/i);
  const raw = labelled?.[1] ?? caption.match(/^\s*(\d{3,6})\s*$/m)?.[1];
  if (!raw) return null;
  const n = Number(raw.replace(/[^\d]/g, ''));
  return n >= 100 && n <= 2_000_000 ? n : null;
}

function parseOrigin(caption: string): string | null {
  const m = caption.match(/made\s*(?:in|n)?\s+([a-z]+)/i) ?? caption.match(/maden\s+([a-z]+)/i);
  if (!m) return null;
  const c = m[1]!.toLowerCase();
  const map: Record<string, string> = { turkey: 'Turkey', türkiye: 'Turkey', italy: 'Italy', usa: 'USA', vietnam: 'Vietnam', china: 'China', uae: 'UAE', dubai: 'UAE', france: 'France', india: 'India' };
  return map[c] ?? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
}

function parseSizes(caption: string): string[] {
  const found = new Set<string>();
  // Letter sizes listed together, e.g. "s m l xl xxxl"
  const letterRun = caption.match(/\b((?:x{0,3}[sml]|x{1,3}l|[2-4]xl)(?:[\s,/]+(?:x{0,3}[sml]|x{1,3}l|[2-4]xl)){1,})\b/i);
  if (letterRun) {
    for (const tok of letterRun[1]!.split(/[\s,/]+/)) {
      let s = tok.toUpperCase();
      if (s === 'XXXL') s = '3XL';
      if (SIZE_TOKENS.includes(s) || s === '3XL') found.add(s);
    }
  }
  // Numeric sizes, e.g. "size 40-45" or "size 42 43 44"
  const sizeLine = caption.match(/size\s*[:\-]?\s*([\d\s,\-–/]+)/i);
  if (sizeLine) {
    const range = sizeLine[1]!.match(/(\d{2})\s*[-–]\s*(\d{2})/);
    if (range) {
      for (let s = Number(range[1]); s <= Number(range[2]) && s - Number(range[1]) < 15; s++) found.add(String(s));
    } else {
      for (const n of sizeLine[1]!.match(/\d{2}/g) ?? []) found.add(n);
    }
  }
  return [...found];
}

export function parseCaption(caption: string): Parsed {
  const price = parsePrice(caption);
  const origin = parseOrigin(caption);
  const sizes = parseSizes(caption);

  // Brand: prefer the title (first meaningful line), because the body is sometimes copy-pasted
  const lines = caption.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines.find((l) => !/^〰+/.test(l) && !/made\s*in/i.test(l)) ?? '';
  const brandEntry =
    BRANDS.find(([, re]) => re.test(title)) ??
    BRANDS.find(([, re]) => re.test(caption.replace(/💯[^\n]*\n?|✨[^\n]*ORIGINAL[^\n]*/gi, ''))) ??
    null;

  let categorySlug = CATEGORY_RULES.find(([, re]) => re.test(caption))?.[0] ?? null;
  if (brandEntry?.[2] && (!categorySlug || categorySlug === 'shirts')) categorySlug = brandEntry[2];
  if (!categorySlug) categorySlug = price !== null && price >= 15000 ? 'suits' : 'shirts';

  // Everything with photos is a product unless it's a greeting; posts without a price are
  // "DM for price" items and become drafts for the owner to price.
  const isProduct = price !== null || !SKIP.test(caption);

  const brand = brandEntry?.[0] ?? null;
  let kind = KIND_NAME[categorySlug] ?? 'Item';
  if (/jelbya|jelabiya|ጀለቢያ/i.test(caption)) kind = 'Jelabiya';
  const lead = brand ?? (origin && origin !== 'Ethiopia' ? (origin === 'Turkey' ? 'Turkish' : origin === 'Italy' ? 'Italian' : origin) : null);
  const name = [lead, kind].filter(Boolean).join(' ');

  return { price, brand, origin, categorySlug, name, sizes, isProduct };
}

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

  const stats = { created: 0, active: 0, skipped: 0, notProduct: 0, noCaption: 0 };
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
    if (await prisma.product.findUnique({ where: { importRef } })) {
      stats.skipped++;
      continue;
    }

    const category = categories.get(parsed.categorySlug) ?? categories.get('shirts')!;
    const postDate = new Date(post.date);
    const activate = parsed.price !== null && (activateAll || (activateSince !== null && postDate >= activateSince));
    byCategory.set(category.slug, (byCategory.get(category.slug) ?? 0) + 1);
    const line = `#${post.id} ${post.date.slice(0, 10)} · ${parsed.name} · ${parsed.price ?? '?'} ETB · ${category.slug} · ${post.photos.length} photo(s)${activate ? ' · ON SALE' : ''}`;

    if (dryRun) {
      console.log(`  ${line}`);
      stats.created++;
      if (activate) stats.active++;
      continue;
    }

    const brand = parsed.brand
      ? await prisma.brand.upsert({ where: { slug: slugify(parsed.brand) }, create: { slug: slugify(parsed.brand), name: parsed.brand }, update: {} })
      : null;
    // Sizes: from the caption if listed, else the category's common sizes
    const sizes = parsed.sizes.length ? parsed.sizes : category.sizes.length ? category.sizes.slice(1, Math.min(category.sizes.length - 1, 6)) : [''];

    const product = await prisma.product.create({
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
        variants: {
          create: sizes.map((size, i) => ({
            sku: `TG${post.id}-${i}-${randomSuffix(3).toUpperCase()}`,
            size,
            stock: activate ? stock : 0,
          })),
        },
      },
    });

    let order = 0;
    for (const rel of post.photos.slice(0, 10)) {
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
    stats.created++;
    if (activate) stats.active++;
    console.log(`  + ${line}`);
  }

  console.log(
    `\n✓ ${dryRun ? 'Would import' : 'Imported'} ${stats.created} products (${stats.active} on sale, ${stats.created - stats.active} drafts)` +
      `\n  skipped: ${stats.skipped} already imported · ${stats.notProduct} greetings/announcements · ${stats.noCaption} photos without text` +
      `\n  by category: ${[...byCategory].map(([k, v]) => `${k} ${v}`).join(', ')}`,
  );
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

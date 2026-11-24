/**
 * Reads product facts from the shop's Telegram captions: price ("Price 4000", "ዋጋ: 5500ብር", "Dm price 4999"),
 * brand, origin ("Made in Turkey"), listed sizes and a category guess. Shared by the one-off channel
 * export import (src/scripts/importTelegram.ts) and the live channel auto-import (telegram/channelImport.ts).
 */
// ─── Caption parsing ─────────────────────────────────────

/** Brand → default category (null = decide from the caption). */
export const BRANDS: [name: string, pattern: RegExp, category: string | null][] = [
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

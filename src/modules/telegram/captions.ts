import type { ProductKind } from '@prisma/client';

/**
 * Builds Telegram channel captions in the shop's own posting style
 * (see docs/reference/telegram/listing-format.md). Unlike the originals,
 * the "original <brand>" lines always use the product's real brand.
 */
export interface CaptionInput {
  kind: ProductKind;
  nameEn: string;
  nameAm?: string | null;
  brand?: string | null;
  price: number;
  origin?: string | null;
  sizes: string[];
  volumeMl?: number | null;
  concentration?: string | null;
  freeDelivery: boolean;
  inbox: string;
  phone: string;
  addressAm: string;
}

const FLAGS: Record<string, string> = {
  turkey: '🇹🇷',
  türkiye: '🇹🇷',
  italy: '🇮🇹',
  uae: '🇦🇪',
  'united arab emirates': '🇦🇪',
  dubai: '🇦🇪',
  france: '🇫🇷',
  china: '🇨🇳',
  usa: '🇺🇸',
  vietnam: '🇻🇳',
  indonesia: '🇮🇩',
  'saudi arabia': '🇸🇦',
  ethiopia: '🇪🇹',
};

export const formatBirr = (n: number) => n.toLocaleString('en-US');

function originLine(origin?: string | null) {
  if (!origin) return null;
  const flag = FLAGS[origin.trim().toLowerCase()] ?? '';
  return `✨ Made in ${origin.trim()}${flag ? ` ${flag}` : ''} ✨`;
}

function sizesLine(sizes: string[]) {
  return sizes.length ? `📏 Size: ${sizes.join(' · ')}` : null;
}

function contactBlock(c: CaptionInput, style: 'shoe' | 'cloth') {
  return style === 'shoe'
    ? [`📩 ለማዘዝ Inbox ያድርጉ። @${c.inbox}`, '', `📞 ${c.phone}`]
    : [`📩 Inbox: @${c.inbox}`, `📲 ስልክ: ${c.phone}`, '', `📍 አድራሻ: ${c.addressAm}`];
}

export function buildCaption(c: CaptionInput): string {
  const brand = c.brand?.trim();
  const BRAND = brand?.toUpperCase();
  const lines: (string | null)[] = [];

  if (c.kind === 'FOOTWEAR') {
    lines.push(
      `👟🔥 ${BRAND ?? c.nameEn.toUpperCase()} 🔥👟`,
      '',
      `💯 ኦሪጂናል ${brand ?? ''} ጫማ`.replace(/\s+/g, ' '),
      '',
      '👟 ምቹና ለዕለታዊ አጠቃቀም ተስማሚ',
      '🔥 ዘመናዊና ልዩ ዲዛይን',
      sizesLine(c.sizes),
      '',
      `💰 ዋጋ፡ ${formatBirr(c.price)} ብር`,
      c.freeDelivery ? '🚚 Free Delivery' : null,
      '',
      ...contactBlock(c, 'shoe'),
      '',
      brand ? `✨ ${BRAND} ORIGINAL — ጥራትና ስታይል በአንድ ላይ! 👟` : '✨ ጥራትና ስታይል በአንድ ላይ! 👟',
    );
  } else if (c.kind === 'FRAGRANCE') {
    lines.push(
      `🌿🔥 ${BRAND ?? ''}${BRAND ? ' — ' : ''}${c.nameEn} 🔥🌿`,
      '',
      '💯 ኦሪጂናል ሽቶ',
      c.volumeMl || c.concentration ? `🧴 ${[c.volumeMl ? `${c.volumeMl}ml` : null, c.concentration].filter(Boolean).join(' · ')}` : null,
      '✨ ረጅም ጊዜ የሚቆይ መዓዛ',
      '',
      `💰 ዋጋ: ${formatBirr(c.price)} ብር`,
      c.freeDelivery ? '🚚 Free Delivery' : null,
      '',
      ...contactBlock(c, 'cloth'),
      '',
      '✨ የልዩ ስታይልዎን ዛሬ ይምረጡ!',
    );
  } else {
    lines.push(
      originLine(c.origin),
      originLine(c.origin) ? '' : null,
      '🔥 Hikma Men’s Fashion 🔥',
      '',
      `👔 ${c.nameAm?.trim() || c.nameEn}${brand ? ` · ${brand}` : ''}`,
      '👔 ጥራት ያለው የወንዶች ልብስ',
      sizesLine(c.sizes),
      c.freeDelivery ? '🚚 Free Delivery' : null,
      `💰 ዋጋ: ${formatBirr(c.price)}ብር`,
      '',
      ...contactBlock(c, 'cloth'),
      '',
      '✨ የልዩ ስታይልዎን ዛሬ ይምረጡ!',
    );
  }

  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

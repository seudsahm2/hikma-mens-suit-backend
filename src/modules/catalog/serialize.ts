import type { Brand, Category, Product, ProductImage, ProductVariant } from '@prisma/client';
import { imageUrls } from '../../lib/storage';

type FullProduct = Product & {
  category: Category;
  brand: Brand | null;
  images: ProductImage[];
  variants: ProductVariant[];
};

/** Stock shown to customers is capped so exact inventory isn't exposed. */
const VISIBLE_STOCK_CAP = 10;

export function serializeImage(img: ProductImage) {
  return {
    id: img.id,
    urls: imageUrls(img.key),
    alt: img.alt,
    color: img.color,
    width: img.width,
    height: img.height,
  };
}

function priceRange(p: Product & { variants: ProductVariant[] }) {
  const active = p.variants.filter((v) => v.isActive);
  const prices = active.length ? active.map((v) => v.price ?? p.basePrice) : [p.basePrice];
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function uniqueColors(variants: ProductVariant[]) {
  const seen = new Map<string, string | null>();
  for (const v of variants) if (v.isActive && v.color && !seen.has(v.color)) seen.set(v.color, v.colorHex);
  return [...seen].map(([name, hex]) => ({ name, hex }));
}

export function serializeCategory(c: Category & { _count?: { products: number } }) {
  return {
    id: c.id,
    slug: c.slug,
    nameEn: c.nameEn,
    nameAm: c.nameAm,
    kind: c.kind,
    imageUrl: c.imageUrl,
    sizes: c.sizes,
    sizeGuide: c.sizeGuide,
    productCount: c._count?.products,
  };
}

/** Lightweight shape for grids. */
export function serializeProductCard(p: FullProduct) {
  const range = priceRange(p);
  const sorted = [...p.images].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    id: p.id,
    slug: p.slug,
    nameEn: p.nameEn,
    nameAm: p.nameAm,
    brand: p.brand ? { slug: p.brand.slug, name: p.brand.name } : null,
    category: { slug: p.category.slug, kind: p.category.kind },
    price: range.min,
    priceMax: range.max,
    compareAtPrice: p.compareAtPrice,
    badge: p.badge,
    isNewArrival: p.isNewArrival,
    inStock: p.variants.some((v) => v.isActive && v.stock > 0),
    colors: uniqueColors(p.variants),
    images: sorted.slice(0, 2).map(serializeImage),
  };
}

/** Full shape for the product page. */
export function serializeProduct(p: FullProduct) {
  const card = serializeProductCard(p);
  const variants = p.variants
    .filter((v) => v.isActive)
    .map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      colorHex: v.colorHex,
      price: v.price ?? p.basePrice,
      available: Math.max(0, Math.min(v.stock, VISIBLE_STOCK_CAP)),
    }));
  const sizeOrder = p.category.sizes;
  const sizes = [...new Set(variants.map((v) => v.size).filter(Boolean))].sort(
    (a, b) => (sizeOrder.indexOf(a) + 1 || 999) - (sizeOrder.indexOf(b) + 1 || 999) || a.localeCompare(b, 'en', { numeric: true }),
  );
  return {
    ...card,
    category: serializeCategory(p.category),
    images: [...p.images].sort((a, b) => a.sortOrder - b.sortOrder).map(serializeImage),
    descriptionEn: p.descriptionEn,
    descriptionAm: p.descriptionAm,
    origin: p.origin,
    material: p.material,
    fit: p.fit,
    tikTokUrl: p.tikTokUrl,
    sizes,
    variants,
    fragrance:
      p.category.kind === 'FRAGRANCE'
        ? {
            concentration: p.concentration,
            volumeMl: p.volumeMl,
            scentFamily: p.scentFamily,
            notesTop: p.notesTop,
            notesHeart: p.notesHeart,
            notesBase: p.notesBase,
          }
        : null,
  };
}

export const productInclude = {
  category: true,
  brand: true,
  images: true,
  variants: true,
} as const;

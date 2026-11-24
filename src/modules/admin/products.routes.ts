import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { onStockRestored } from '../alerts/backInStock';
import { ah, badRequest, notFound } from '../../lib/http';
import { randomSuffix, slugify } from '../../lib/slug';
import { deleteImage, saveImage } from '../../lib/storage';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { serializeCategory, serializeImage } from '../catalog/serialize';
import { previewCaption, publishToChannel } from '../telegram/publish';
import { startBroadcast, subscriberCount } from '../telegram/broadcast';
import { normalizeTikTokUrl } from '../../lib/tiktok';
import { imageUrls } from '../../lib/storage';

export const adminProductsRouter = Router();

const include = {
  category: true,
  brand: true,
  images: { orderBy: { sortOrder: 'asc' } },
  proofs: { orderBy: { sortOrder: 'asc' } },
  variants: {
    orderBy: [{ color: 'asc' }, { size: 'asc' }],
    // how many customers are waiting for each sold-out size ("Notify me when back")
    include: { _count: { select: { alerts: { where: { notifiedAt: null } } } } },
  },
} satisfies Prisma.ProductInclude;

type AdminProduct = Prisma.ProductGetPayload<{ include: typeof include }>;

function serializeAdminProduct(p: AdminProduct) {
  return {
    ...p,
    category: serializeCategory(p.category),
    brand: p.brand ? { id: p.brand.id, slug: p.brand.slug, name: p.brand.name } : null,
    images: p.images.map(serializeImage),
    proofs: p.proofs.map((x) => ({ id: x.id, label: x.label, urls: imageUrls(x.key) })),
    totalStock: p.variants.reduce((s, v) => s + (v.isActive ? v.stock : 0), 0),
  };
}

const optStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const strList = z.array(z.string().trim().min(1).max(60)).max(30).default([]);

const productSchema = z.object({
  nameEn: z.string().trim().min(2).max(120),
  nameAm: optStr(120),
  descriptionEn: optStr(2000),
  descriptionAm: optStr(2000),
  categoryId: z.string().min(1),
  brandName: optStr(60), // brand is created on the fly if new
  origin: optStr(40),
  material: optStr(120),
  fit: optStr(40),
  basePrice: z.number().int().min(0).max(10_000_000),
  compareAtPrice: z.number().int().min(0).max(10_000_000).nullish(),
  costPrice: z.number().int().min(0).max(10_000_000).nullish(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('DRAFT'),
  isFeatured: z.boolean().default(false),
  isNewArrival: z.boolean().default(true),
  badge: optStr(24),
  tags: strList,
  concentration: optStr(20),
  volumeMl: z.number().int().min(1).max(5000).nullish(),
  scentFamily: optStr(40),
  notesTop: strList,
  notesHeart: strList,
  notesBase: strList,
  tikTokUrl: optStr(300),
});

async function resolveBrandId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;
  const brand = await prisma.brand.upsert({ where: { slug }, create: { slug, name }, update: {} });
  return brand.id;
}

async function uniqueSlug(base: string, excludeId?: string) {
  const root = slugify(base) || 'item';
  let slug = root;
  for (let i = 0; i < 5; i++) {
    const clash = await prisma.product.findFirst({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (!clash) return slug;
    slug = `${root}-${randomSuffix()}`;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/**
 * A product only goes on sale with at least one photo and some stock, so the owner can never
 * publish something that shows up as "sold out" just because the quantity was forgotten.
 * Products that are already on sale and sell out later are not affected.
 */
async function assertSellable(productId: string | null) {
  const [images, stock] = productId
    ? await Promise.all([
        prisma.productImage.count({ where: { productId } }),
        prisma.productVariant.aggregate({ where: { productId, isActive: true }, _sum: { stock: true } }),
      ])
    : [0, null];
  if (!images) throw badRequest('Add at least one photo before putting it on sale', 'NO_PHOTO');
  if (!stock?._sum.stock) throw badRequest('Add how many you have (stock) before putting it on sale', 'NO_STOCK');
}

// List
adminProductsRouter.get(
  '/',
  validate(
    z.object({
      q: z.string().trim().max(80).optional(),
      category: z.string().optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
      lowStock: z.enum(['1', 'true']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    'query',
  ),
  ah(async (req, res) => {
    const q = req.query as unknown as { q?: string; category?: string; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; lowStock?: string; page: number; limit: number };
    const where: Prisma.ProductWhereInput = {
      ...(q.status ? { status: q.status } : { status: { not: 'ARCHIVED' } }),
      ...(q.category ? { categoryId: q.category } : {}),
      ...(q.lowStock ? { variants: { some: { isActive: true, stock: { lte: 2 } } } } : {}),
      ...(q.q
        ? {
            OR: [
              { nameEn: { contains: q.q, mode: 'insensitive' } },
              { nameAm: { contains: q.q } },
              { brand: { name: { contains: q.q, mode: 'insensitive' } } },
              { variants: { some: { sku: { contains: q.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, include, orderBy: { updatedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    res.json({ products: products.map(serializeAdminProduct), total, page: q.page, hasMore: q.page * q.limit < total });
  }),
);

adminProductsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include });
    if (!p) throw notFound('Product not found');
    res.json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.post(
  '/',
  validate(productSchema),
  ah(async (req, res) => {
    const { brandName, ...data } = req.body as z.infer<typeof productSchema>;
    data.tikTokUrl = await normalizeTikTokUrl(data.tikTokUrl);
    if (data.status === 'ACTIVE') await assertSellable(null); // new products have no photos yet: create, add photos + stock, then activate
    const p = await prisma.product.create({
      data: { ...data, slug: await uniqueSlug(data.nameEn), brandId: await resolveBrandId(brandName) },
      include,
    });
    res.status(201).json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.put(
  '/:id',
  validate(productSchema),
  ah(async (req, res) => {
    const { brandName, ...data } = req.body as z.infer<typeof productSchema>;
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (existing && data.tikTokUrl !== existing.tikTokUrl) data.tikTokUrl = await normalizeTikTokUrl(data.tikTokUrl);
    if (!existing) throw notFound('Product not found');
    if (data.status === 'ACTIVE' && existing.status !== 'ACTIVE') await assertSellable(existing.id);
    const p = await prisma.product.update({
      where: { id: existing.id },
      data: {
        ...data,
        brandId: await resolveBrandId(brandName),
        // Keep the URL stable once the product is live
        ...(existing.status === 'DRAFT' && existing.nameEn !== data.nameEn ? { slug: await uniqueSlug(data.nameEn, existing.id) } : {}),
      },
      include,
    });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.patch(
  '/:id/status',
  validate(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) })),
  ah(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Product not found');
    if (req.body.status === 'ACTIVE' && existing.status !== 'ACTIVE') await assertSellable(existing.id);
    const p = await prisma.product.update({ where: { id: existing.id }, data: { status: req.body.status }, include });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

/** Deletes a product that was never ordered; otherwise archives it. */
adminProductsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const id = req.params.id!;
    const ordered = await prisma.orderItem.count({ where: { productId: id } });
    if (ordered > 0) {
      await prisma.product.update({ where: { id }, data: { status: 'ARCHIVED' } });
      return res.json({ archived: true });
    }
    const [images, proofs] = await Promise.all([
      prisma.productImage.findMany({ where: { productId: id } }),
      prisma.proofPhoto.findMany({ where: { productId: id } }),
    ]);
    await prisma.product.delete({ where: { id } });
    await Promise.all([...images, ...proofs].map((i) => deleteImage(i.key)));
    res.json({ deleted: true });
  }),
);

// ─── Variants (size × colour matrix) ─────────────────────

const variantsSchema = z.object({
  variants: z
    .array(
      z.object({
        id: z.string().optional(),
        size: z.string().trim().max(20).default(''),
        color: z.string().trim().max(30).default(''),
        colorHex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullish(),
        price: z.number().int().min(0).max(10_000_000).nullish(),
        stock: z.number().int().min(0).max(100_000),
        isActive: z.boolean().default(true),
      }),
    )
    .max(200),
});

adminProductsRouter.put(
  '/:id/variants',
  validate(variantsSchema),
  ah(async (req, res) => {
    const productId = req.params.id!;
    const { variants } = req.body as z.infer<typeof variantsSchema>;
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { variants: true } });
    if (!product) throw notFound('Product not found');

    const keys = new Set<string>();
    for (const v of variants) {
      const k = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
      if (keys.has(k)) throw badRequest(`Duplicate variant: ${[v.size, v.color].filter(Boolean).join(' / ')}`, 'DUPLICATE_VARIANT');
      keys.add(k);
    }

    const actorId = req.user!.id;
    await prisma.$transaction(async (tx) => {
      const byKey = new Map(product.variants.map((v) => [`${v.size.toLowerCase()}|${v.color.toLowerCase()}`, v]));
      const keep = new Set<string>();
      for (const v of variants) {
        const existing = byKey.get(`${v.size.toLowerCase()}|${v.color.toLowerCase()}`);
        if (existing) {
          keep.add(existing.id);
          const delta = v.stock - existing.stock;
          await tx.productVariant.update({
            where: { id: existing.id },
            data: { size: v.size, color: v.color, colorHex: v.colorHex ?? null, price: v.price ?? null, stock: v.stock, isActive: v.isActive },
          });
          if (delta !== 0) {
            await tx.stockMovement.create({ data: { variantId: existing.id, delta, reason: delta > 0 ? 'RESTOCK' : 'ADJUST', actorId } });
          }
        } else {
          const sku = `HM-${product.slug.slice(0, 18).toUpperCase()}-${slugify(`${v.size}-${v.color}`).toUpperCase() || 'STD'}-${randomSuffix(3).toUpperCase()}`;
          const created = await tx.productVariant.create({
            data: { productId, sku, size: v.size, color: v.color, colorHex: v.colorHex ?? null, price: v.price ?? null, stock: v.stock, isActive: v.isActive },
          });
          keep.add(created.id);
          if (v.stock > 0) await tx.stockMovement.create({ data: { variantId: created.id, delta: v.stock, reason: 'RESTOCK', actorId } });
        }
      }
      // Removed rows: delete if never ordered, else deactivate
      for (const old of product.variants) {
        if (keep.has(old.id)) continue;
        const used = await tx.orderItem.count({ where: { variantId: old.id } });
        if (used) await tx.productVariant.update({ where: { id: old.id }, data: { isActive: false } });
        else await tx.productVariant.delete({ where: { id: old.id } });
      }
    });

    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include });
    // Anyone waiting for a size that now has stock gets a Telegram message
    onStockRestored(p.variants.filter((v) => v.stock > 0).map((v) => v.id));
    res.json({ product: serializeAdminProduct(p) });
  }),
);

// ─── Images ──────────────────────────────────────────────

adminProductsRouter.post(
  '/:id/images',
  imageUpload.array('images', 12),
  ah(async (req, res) => {
    const productId = req.params.id!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('Choose at least one image', 'NO_FILES');
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { images: true } });
    if (!product) throw notFound('Product not found');

    let order = product.images.reduce((m, i) => Math.max(m, i.sortOrder), -1);
    for (const file of files) {
      const saved = await saveImage(file.buffer, 'products');
      await prisma.productImage.create({
        data: { productId, key: saved.key, width: saved.width, height: saved.height, sortOrder: ++order, alt: product.nameEn },
      });
    }
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include });
    res.status(201).json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.put(
  '/:id/images/order',
  validate(z.object({ imageIds: z.array(z.string()).max(50) })),
  ah(async (req, res) => {
    const productId = req.params.id!;
    const ids = req.body.imageIds as string[];
    await prisma.$transaction(
      ids.map((imageId, idx) => prisma.productImage.updateMany({ where: { id: imageId, productId }, data: { sortOrder: idx } })),
    );
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.patch(
  '/:id/images/:imageId',
  validate(z.object({ color: optStr(30), alt: optStr(160) })),
  ah(async (req, res) => {
    await prisma.productImage.updateMany({ where: { id: req.params.imageId, productId: req.params.id }, data: req.body });
    const p = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id }, include });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.delete(
  '/:id/images/:imageId',
  ah(async (req, res) => {
    const img = await prisma.productImage.findFirst({ where: { id: req.params.imageId, productId: req.params.id } });
    if (!img) throw notFound('Image not found');
    await prisma.productImage.delete({ where: { id: img.id } });
    await deleteImage(img.key);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id }, include });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

// ─── "Original" proof photos ─────────────────────────────

adminProductsRouter.post(
  '/:id/proofs',
  imageUpload.array('images', 6),
  ah(async (req, res) => {
    const productId = req.params.id!;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('Choose at least one photo', 'NO_FILES');
    const label = ['box', 'tag', 'receipt'].includes(String(req.body?.label)) ? String(req.body.label) : 'other';
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { proofs: true } });
    if (!product) throw notFound('Product not found');
    if (product.proofs.length + files.length > 8) throw badRequest('Up to 8 proof photos', 'TOO_MANY');
    let order = product.proofs.reduce((m, i) => Math.max(m, i.sortOrder), -1);
    for (const file of files) {
      const saved = await saveImage(file.buffer, 'originals');
      await prisma.proofPhoto.create({ data: { productId, key: saved.key, width: saved.width, height: saved.height, label, sortOrder: ++order } });
    }
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include });
    res.status(201).json({ product: serializeAdminProduct(p) });
  }),
);

adminProductsRouter.delete(
  '/:id/proofs/:proofId',
  ah(async (req, res) => {
    const proof = await prisma.proofPhoto.findFirst({ where: { id: req.params.proofId, productId: req.params.id } });
    if (!proof) throw notFound('Photo not found');
    await prisma.proofPhoto.delete({ where: { id: proof.id } });
    await deleteImage(proof.key);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id }, include });
    res.json({ product: serializeAdminProduct(p) });
  }),
);

// ─── Telegram channel ────────────────────────────────────

adminProductsRouter.get(
  '/:id/caption',
  ah(async (req, res) => {
    res.json({ caption: await previewCaption(req.params.id!) });
  }),
);

adminProductsRouter.post(
  '/:id/publish',
  validate(z.object({ caption: z.string().max(1024).optional() })),
  ah(async (req, res) => {
    res.json(await publishToChannel(req.params.id!, req.body.caption));
  }),
);

// ─── New-arrival announcement ────────────────────────────

/** Subscriber count and the latest announcement of this product. */
adminProductsRouter.get(
  '/:id/announce',
  ah(async (req, res) => {
    const [subscribers, last] = await Promise.all([
      subscriberCount(),
      prisma.broadcast.findFirst({ where: { productId: req.params.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    res.json({ subscribers, last });
  }),
);

adminProductsRouter.post(
  '/:id/announce',
  validate(z.object({ force: z.boolean().default(false) })),
  ah(async (req, res) => {
    const broadcast = await startBroadcast(req.params.id!, req.user!.id, req.body.force);
    res.status(201).json({ broadcast });
  }),
);

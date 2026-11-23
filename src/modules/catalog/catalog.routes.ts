import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, notFound } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { validate } from '../../middleware/validate';
import { productInclude, serializeCategory, serializeProduct, serializeProductCard } from './serialize';

export const catalogRouter = Router();

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

const listQuery = z.object({
  category: z.string().max(60).optional(),
  brand: csv,
  size: csv,
  color: csv,
  min: z.coerce.number().int().min(0).optional(),
  max: z.coerce.number().int().min(0).optional(),
  inStock: z.enum(['1', 'true']).optional(),
  featured: z.enum(['1', 'true']).optional(),
  new: z.enum(['1', 'true']).optional(),
  q: z.string().trim().max(80).optional(),
  sort: z.enum(['new', 'price_asc', 'price_desc', 'featured']).default('new'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
  exclude: z.string().max(40).optional(),
});

catalogRouter.get(
  '/categories',
  ah(async (_req, res) => {
    const [categories, covers] = await Promise.all([
      prisma.category.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { _count: { select: { products: { where: { status: 'ACTIVE' } } } } },
      }),
      // Fallback tile image: the newest (featured first) product photo in each category
      prisma.product.findMany({
        where: { status: 'ACTIVE', images: { some: {} } },
        distinct: ['categoryId'],
        orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
        select: { categoryId: true, images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { key: true } } },
      }),
    ]);
    const coverOf = new Map(covers.map((c) => [c.categoryId, c.images[0] ? imageUrls(c.images[0].key).md : null]));
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      categories: categories.map((c) => ({ ...serializeCategory(c), imageUrl: c.imageUrl ?? coverOf.get(c.id) ?? null })),
    });
  }),
);

catalogRouter.get(
  '/brands',
  ah(async (_req, res) => {
    const brands = await prisma.brand.findMany({
      where: { products: { some: { status: 'ACTIVE' } } },
      orderBy: { name: 'asc' },
      select: { slug: true, name: true },
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ brands });
  }),
);

catalogRouter.get(
  '/products',
  validate(listQuery, 'query'),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const variantFilter: Prisma.ProductVariantWhereInput = { isActive: true };
    if (q.size) variantFilter.size = { in: q.size };
    if (q.color) variantFilter.color = { in: q.color, mode: 'insensitive' };
    if (q.inStock || q.size || q.color) variantFilter.stock = { gt: 0 };

    const where: Prisma.ProductWhereInput = {
      status: 'ACTIVE',
      ...(q.category ? { category: { slug: q.category } } : {}),
      ...(q.brand ? { brand: { slug: { in: q.brand } } } : {}),
      ...(q.featured ? { isFeatured: true } : {}),
      ...(q.new ? { isNewArrival: true } : {}),
      ...(q.exclude ? { id: { not: q.exclude } } : {}),
      ...(q.min !== undefined || q.max !== undefined
        ? { basePrice: { ...(q.min !== undefined ? { gte: q.min } : {}), ...(q.max !== undefined ? { lte: q.max } : {}) } }
        : {}),
      ...(q.size || q.color || q.inStock ? { variants: { some: variantFilter } } : {}),
      ...(q.q
        ? {
            OR: [
              { nameEn: { contains: q.q, mode: 'insensitive' } },
              { nameAm: { contains: q.q } },
              { brand: { name: { contains: q.q, mode: 'insensitive' } } },
              { category: { nameEn: { contains: q.q, mode: 'insensitive' } } },
              { tags: { has: q.q.toLowerCase() } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      q.sort === 'price_asc'
        ? [{ basePrice: 'asc' }]
        : q.sort === 'price_desc'
          ? [{ basePrice: 'desc' }]
          : q.sort === 'featured'
            ? [{ isFeatured: 'desc' }, { createdAt: 'desc' }]
            : [{ createdAt: 'desc' }];

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy,
        include: productInclude,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);

    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      products: products.map(serializeProductCard),
      page: q.page,
      limit: q.limit,
      total,
      hasMore: q.page * q.limit < total,
    });
  }),
);

catalogRouter.get(
  '/products/:slug',
  ah(async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { slug: req.params.slug, status: 'ACTIVE' },
      include: productInclude,
    });
    if (!product) throw notFound('Product not found');
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ product: serializeProduct(product) });
  }),
);

/** Facets for the filter sheet of a category (sizes, colours, brands, price bounds). */
catalogRouter.get(
  '/facets',
  validate(z.object({ category: z.string().max(60).optional() }), 'query'),
  ah(async (req, res) => {
    const category = (req.query as { category?: string }).category;
    const productWhere: Prisma.ProductWhereInput = {
      status: 'ACTIVE',
      ...(category ? { category: { slug: category } } : {}),
    };
    const [variants, brands, bounds] = await Promise.all([
      prisma.productVariant.findMany({
        where: { isActive: true, stock: { gt: 0 }, product: productWhere },
        select: { size: true, color: true, colorHex: true },
        distinct: ['size', 'color'],
      }),
      prisma.brand.findMany({
        where: { products: { some: productWhere } },
        select: { slug: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.product.aggregate({ where: productWhere, _min: { basePrice: true }, _max: { basePrice: true } }),
    ]);
    const sizes = [...new Set(variants.map((v) => v.size).filter(Boolean))];
    const colors = new Map<string, string | null>();
    for (const v of variants) if (v.color && !colors.has(v.color)) colors.set(v.color, v.colorHex);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      sizes,
      colors: [...colors].map(([name, hex]) => ({ name, hex })),
      brands,
      price: { min: bounds._min.basePrice ?? 0, max: bounds._max.basePrice ?? 0 },
    });
  }),
);

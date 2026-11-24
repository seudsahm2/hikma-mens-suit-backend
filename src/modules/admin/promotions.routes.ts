import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { requireOwner } from '../../middleware/auth';
import { validate } from '../../middleware/validate';

/** Owner: campaigns & promo codes, "complete the look" sets. */
export const adminPromotionsRouter = Router();
// Owner only — scoped to these paths, so other /api/admin routes mounted after this router stay open to admins
adminPromotionsRouter.use(['/promotions', '/bundles'], requireOwner);

// ─── Campaigns & codes ───────────────────────────────────

const optStr = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const promoSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    code: z
      .string()
      .trim()
      .max(24)
      .nullish()
      .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, '') : null))
      .refine((v) => v === null || /^[A-Z0-9_-]{3,24}$/.test(v), 'Use 3–24 letters or numbers'),
    type: z.enum(['PERCENT', 'FIXED', 'GIFT']),
    value: z.number().int().min(0).max(1_000_000).default(0),
    giftText: optStr(120),
    minSubtotal: z.number().int().min(0).max(10_000_000).default(0),
    categorySlug: optStr(60),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    isActive: z.boolean().default(true),
    maxUses: z.number().int().min(1).max(1_000_000).nullish(),
    onePerCustomer: z.boolean().default(true),
    bannerEn: optStr(140),
    bannerAm: optStr(140),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'PERCENT' && (p.value < 1 || p.value > 90)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Choose 1–90%' });
    if (p.type === 'FIXED' && p.value < 1) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter an amount' });
    if (p.type === 'GIFT' && !p.giftText) ctx.addIssue({ code: 'custom', path: ['giftText'], message: 'Describe the gift' });
    if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Ends before it starts' });
  });

async function saveCatch<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('This code is already used by another promotion', 'CODE_TAKEN');
    throw err;
  }
}

adminPromotionsRouter.get(
  '/promotions',
  ah(async (_req, res) => {
    const promos = await prisma.promotion.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }] });
    const sales = await prisma.order.groupBy({
      by: ['promotionId'],
      where: { promotionId: { in: promos.map((p) => p.id) }, status: { not: 'CANCELLED' } },
      _sum: { total: true, discountTotal: true },
      _count: true,
    });
    const byId = new Map(sales.map((s) => [s.promotionId, s]));
    res.json({
      promotions: promos.map((p) => ({
        ...p,
        stats: { orders: byId.get(p.id)?._count ?? 0, revenue: byId.get(p.id)?._sum.total ?? 0 },
      })),
    });
  }),
);

adminPromotionsRouter.post(
  '/promotions',
  validate(promoSchema),
  ah(async (req, res) => {
    const promotion = await saveCatch(() => prisma.promotion.create({ data: req.body }));
    res.status(201).json({ promotion });
  }),
);

adminPromotionsRouter.put(
  '/promotions/:id',
  validate(promoSchema),
  ah(async (req, res) => {
    const promotion = await saveCatch(() => prisma.promotion.update({ where: { id: req.params.id }, data: req.body }));
    res.json({ promotion });
  }),
);

adminPromotionsRouter.delete(
  '/promotions/:id',
  ah(async (req, res) => {
    const used = await prisma.order.count({ where: { promotionId: req.params.id } });
    // Orders keep their history: a used promotion is switched off instead of deleted
    if (used) await prisma.promotion.update({ where: { id: req.params.id }, data: { isActive: false } });
    else await prisma.promotion.delete({ where: { id: req.params.id } });
    res.json({ ok: true, archived: used > 0 });
  }),
);

// ─── "Complete the look" sets ────────────────────────────

const bundleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  nameAm: optStr(60),
  discountPercent: z.number().int().min(1).max(50),
  isActive: z.boolean().default(true),
  productIds: z.array(z.string().min(1).max(40)).min(2).max(5),
});

adminPromotionsRouter.get(
  '/bundles',
  ah(async (_req, res) => {
    const bundles = await prisma.bundle.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { product: { select: { id: true, nameEn: true, basePrice: true, status: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
        },
      },
    });
    res.json({
      bundles: bundles.map((b) => ({
        id: b.id,
        name: b.name,
        nameAm: b.nameAm,
        discountPercent: b.discountPercent,
        isActive: b.isActive,
        products: b.items.map((i) => ({
          id: i.product.id,
          nameEn: i.product.nameEn,
          basePrice: i.product.basePrice,
          status: i.product.status,
          image: i.product.images[0] ? imageUrls(i.product.images[0].key).sm : null,
        })),
      })),
    });
  }),
);

async function saveBundle(id: string | null, body: z.infer<typeof bundleSchema>) {
  const ids = [...new Set(body.productIds)];
  if (ids.length < 2) throw badRequest('Pick at least 2 different products', 'BUNDLE_SIZE');
  const found = await prisma.product.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw notFound('A product in this look no longer exists');
  const data = { name: body.name, nameAm: body.nameAm, discountPercent: body.discountPercent, isActive: body.isActive };
  return prisma.$transaction(async (tx) => {
    const b = id ? await tx.bundle.update({ where: { id }, data }) : await tx.bundle.create({ data });
    await tx.bundleItem.deleteMany({ where: { bundleId: b.id } });
    await tx.bundleItem.createMany({ data: ids.map((productId, sortOrder) => ({ bundleId: b.id, productId, sortOrder })) });
    return b;
  });
}

adminPromotionsRouter.post(
  '/bundles',
  validate(bundleSchema),
  ah(async (req, res) => {
    res.status(201).json({ bundle: await saveBundle(null, req.body) });
  }),
);

adminPromotionsRouter.put(
  '/bundles/:id',
  validate(bundleSchema),
  ah(async (req, res) => {
    res.json({ bundle: await saveBundle(req.params.id!, req.body) });
  }),
);

adminPromotionsRouter.delete(
  '/bundles/:id',
  ah(async (req, res) => {
    await prisma.bundle.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

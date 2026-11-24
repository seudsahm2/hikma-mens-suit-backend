import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, notFound } from '../../lib/http';
import { requireAuth } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { productInclude, serializeProduct } from '../catalog/serialize';
import { quote } from './pricing';
import { attachInvite, rewardsSummary } from './rewards';

/** Checkout price quote, running campaigns, "complete the look" sets, and the customer's rewards. */
export const pricingRouter = Router();

/** What this bag costs right now (same calculation the order uses). Signed-in or not. */
pricingRouter.post(
  '/checkout/quote',
  limiter({ windowMs: 60_000, limit: 120 }),
  validate(
    z.object({
      items: z.array(z.object({ variantId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(20) })).min(1).max(30),
      code: z.string().trim().max(40).optional(),
      invite: z.string().trim().max(40).optional(),
      useCredit: z.boolean().default(false),
    }),
  ),
  ah(async (req, res) => {
    const { items, code, invite, useCredit } = req.body as { items: { variantId: string; quantity: number }[]; code?: string; invite?: string; useCredit: boolean };
    const qty = new Map<string, number>();
    for (const it of items) qty.set(it.variantId, (qty.get(it.variantId) ?? 0) + it.quantity);
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: [...qty.keys()] }, isActive: true, product: { status: 'ACTIVE' } },
      include: { product: { select: { basePrice: true, category: { select: { slug: true } } } } },
    });
    const q = await quote(
      variants.map((v) => ({ variantId: v.id, productId: v.productId, categorySlug: v.product.category.slug, unitPrice: v.price ?? v.product.basePrice, quantity: qty.get(v.id)! })),
      { user: req.user ?? null, code, invite, useCredit },
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      subtotal: q.subtotal,
      discounts: q.discounts,
      discountTotal: q.discountTotal,
      itemsTotal: q.itemsTotal,
      giftNote: q.giftNote,
      creditUsed: q.creditUsed,
      creditBalance: q.creditBalance,
      codeError: q.codeError,
      codeApplied: q.codeApplied,
      invite: q.invite,
      inviteError: q.inviteError,
    });
  }),
);

/** Running automatic campaigns (for the shop banner). */
pricingRouter.get(
  '/promotions/active',
  ah(async (_req, res) => {
    const now = new Date();
    const promos = await prisma.promotion.findMany({
      where: { code: null, isActive: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
      orderBy: { createdAt: 'desc' },
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      campaigns: promos
        .filter((p) => p.maxUses === null || p.usedCount < p.maxUses)
        .map((p) => ({ id: p.id, name: p.name, type: p.type, value: p.value, giftText: p.giftText, minSubtotal: p.minSubtotal, categorySlug: p.categorySlug, endsAt: p.endsAt, bannerEn: p.bannerEn, bannerAm: p.bannerAm })),
    });
  }),
);

/** "Complete the look" sets that contain this product, with the other pieces (full product data for size picking). */
pricingRouter.get(
  '/looks',
  validate(z.object({ product: z.string().min(1).max(120) }), 'query'),
  ah(async (req, res) => {
    const slug = (req.query as { product: string }).product;
    const product = await prisma.product.findFirst({ where: { slug, status: 'ACTIVE' }, select: { id: true } });
    if (!product) throw notFound('Product not found');
    const bundles = await prisma.bundle.findMany({
      where: { isActive: true, items: { some: { productId: product.id } } },
      include: { items: { orderBy: { sortOrder: 'asc' }, include: { product: { include: productInclude } } } },
      take: 3,
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      looks: bundles
        // every piece must be on sale and have stock, or the look can't be bought
        .filter((b) => b.items.length >= 2 && b.items.every((i) => i.product.status === 'ACTIVE' && i.product.variants.some((v) => v.isActive && v.stock > 0)))
        .map((b) => ({
          id: b.id,
          name: b.name,
          nameAm: b.nameAm,
          discountPercent: b.discountPercent,
          products: b.items.map((i) => serializeProduct(i.product)),
        })),
    });
  }),
);

/** Save the inviter on the signed-in customer's account (called when they arrive with an invite). */
pricingRouter.post(
  '/rewards/invite',
  requireAuth,
  limiter({ windowMs: 60 * 60_000, limit: 30 }),
  validate(z.object({ code: z.string().trim().min(3).max(40) })),
  ah(async (req, res) => {
    res.json(await attachInvite(req.user!.id, req.body.code));
  }),
);

/** Credit, VIP level, invite link. */
pricingRouter.get(
  '/rewards',
  requireAuth,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await rewardsSummary(req.user!.id));
  }),
);

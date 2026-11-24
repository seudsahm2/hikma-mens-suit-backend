import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';

/**
 * The signed-in customer's bag, kept on the server:
 *  - the same bag on the website and in the Telegram app
 *  - one gentle reminder if it's left behind (see bagReminder.ts)
 */
export const cartRouter = Router();
cartRouter.use(requireAuth);

type Item = { variantId: string; quantity: number };
const VISIBLE_STOCK_CAP = 10;

function normalize(items: Item[]): Item[] {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.variantId, Math.min(20, (merged.get(i.variantId) ?? 0) + i.quantity));
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity })).sort((a, b) => a.variantId.localeCompare(b.variantId));
}

/** The saved bag, with what the shop needs to show it (only items still on sale and in stock). */
cartRouter.get(
  '/',
  ah(async (req, res) => {
    const snap = await prisma.cartSnapshot.findUnique({ where: { userId: req.user!.id } });
    const items = (snap?.items as Item[] | undefined) ?? [];
    if (!items.length) return res.json({ lines: [] });
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: items.map((i) => i.variantId) }, isActive: true, stock: { gt: 0 }, product: { status: 'ACTIVE' } },
      include: { product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const lines = items.flatMap((i) => {
      const v = byId.get(i.variantId);
      if (!v) return [];
      const max = Math.min(v.stock, VISIBLE_STOCK_CAP);
      return [
        {
          variantId: v.id,
          productId: v.productId,
          slug: v.product.slug,
          name: v.product.nameEn,
          image: v.product.images[0] ? imageUrls(v.product.images[0].key).sm : null,
          size: v.size,
          color: v.color,
          price: v.price ?? v.product.basePrice,
          quantity: Math.min(i.quantity, max),
          max,
        },
      ];
    });
    res.json({ lines });
  }),
);

/** Replace the saved bag. Unchanged bags are not rewritten, so opening the app doesn't restart the reminder clock. */
cartRouter.put(
  '/',
  limiter({ windowMs: 60_000, limit: 60 }),
  validate(z.object({ items: z.array(z.object({ variantId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(50) })).max(40) })),
  ah(async (req, res) => {
    const userId = req.user!.id;
    const items = normalize(req.body.items as Item[]);
    if (!items.length) {
      await prisma.cartSnapshot.deleteMany({ where: { userId } });
      return res.json({ ok: true });
    }
    const existing = await prisma.cartSnapshot.findUnique({ where: { userId } });
    if (existing && JSON.stringify(existing.items) === JSON.stringify(items)) return res.json({ ok: true });
    const itemCount = items.reduce((n, i) => n + i.quantity, 0);
    const data = { items: items as unknown as Prisma.InputJsonValue, itemCount };
    await prisma.cartSnapshot.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    res.json({ ok: true });
  }),
);

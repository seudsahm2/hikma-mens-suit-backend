/**
 * Inventory insights: what isn't selling, which sizes sell per category, what to reorder before it
 * runs out, and what the stock is worth. Based on orders that weren't cancelled.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { validate } from '../../middleware/validate';

export const insightsRouter = Router();

insightsRouter.get(
  '/',
  validate(z.object({ days: z.coerce.number().int().min(14).max(365).default(60) }), 'query'),
  ah(async (req, res) => {
    const days = (req.query as unknown as { days: number }).days;
    const since = new Date(Date.now() - days * 86400_000);
    const last30 = new Date(Date.now() - 30 * 86400_000);

    const [products, sold, sold30, missingAm] = await Promise.all([
      prisma.product.findMany({
        where: { status: 'ACTIVE' },
        include: { category: { select: { slug: true, nameEn: true, sizes: true } }, variants: { where: { isActive: true } }, images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
      }),
      prisma.orderItem.groupBy({ by: ['productId'], where: { order: { createdAt: { gte: since }, status: { not: 'CANCELLED' } } }, _sum: { quantity: true } }),
      prisma.orderItem.groupBy({ by: ['variantId'], where: { order: { createdAt: { gte: last30 }, status: { not: 'CANCELLED' } } }, _sum: { quantity: true } }),
      prisma.product.count({ where: { status: { not: 'ARCHIVED' }, OR: [{ nameAm: null }, { nameAm: '' }] } }),
    ]);
    const soldBy = new Map(sold.map((s) => [s.productId, s._sum.quantity ?? 0]));
    const sold30By = new Map(sold30.map((s) => [s.variantId, s._sum.quantity ?? 0]));

    // Stock value
    let retail = 0;
    let cost = 0;
    let pieces = 0;
    for (const p of products) {
      for (const v of p.variants) {
        pieces += v.stock;
        retail += v.stock * (v.price ?? p.basePrice);
        cost += v.stock * (p.costPrice ?? 0);
      }
    }

    // Slow movers: in stock for a while, sold nothing in the period
    const slow = products
      .map((p) => ({ p, stock: p.variants.reduce((n, v) => n + v.stock, 0), sold: soldBy.get(p.id) ?? 0 }))
      .filter((x) => x.stock > 0 && x.sold === 0 && x.p.createdAt < since)
      .sort((a, b) => b.stock * b.p.basePrice - a.stock * a.p.basePrice)
      .slice(0, 12)
      .map((x) => ({
        id: x.p.id,
        name: x.p.nameEn,
        image: x.p.images[0] ? imageUrls(x.p.images[0].key).sm : null,
        stock: x.stock,
        value: x.stock * x.p.basePrice,
        daysListed: Math.round((Date.now() - x.p.createdAt.getTime()) / 86400_000),
      }));

    // Reorder: selling sizes that run out within ~3 weeks at the last-30-days pace
    const reorder = products
      .flatMap((p) =>
        p.variants.map((v) => {
          const perDay = (sold30By.get(v.id) ?? 0) / 30;
          return { p, v, perDay, daysLeft: perDay > 0 ? Math.floor(v.stock / perDay) : null };
        }),
      )
      .filter((x) => x.perDay > 0 && x.daysLeft !== null && x.daysLeft <= 21)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
      .slice(0, 15)
      .map((x) => ({
        productId: x.p.id,
        name: x.p.nameEn,
        size: x.v.size,
        color: x.v.color,
        stock: x.v.stock,
        soldLast30: sold30By.get(x.v.id) ?? 0,
        daysLeft: x.daysLeft,
      }));

    // Best-selling sizes per category (period)
    const sizeRows = await prisma.orderItem.groupBy({
      by: ['productId', 'size'],
      where: { size: { not: '' }, order: { createdAt: { gte: since }, status: { not: 'CANCELLED' } } },
      _sum: { quantity: true },
    });
    const catOf = new Map(products.map((p) => [p.id, p.category]));
    const byCat = new Map<string, { name: string; order: string[]; sizes: Map<string, number> }>();
    for (const r of sizeRows) {
      const c = catOf.get(r.productId);
      if (!c) continue;
      const entry = byCat.get(c.slug) ?? { name: c.nameEn, order: c.sizes, sizes: new Map() };
      entry.sizes.set(r.size, (entry.sizes.get(r.size) ?? 0) + (r._sum.quantity ?? 0));
      byCat.set(c.slug, entry);
    }
    const sizes = [...byCat.entries()]
      .map(([slug, e]) => ({
        category: e.name,
        slug,
        total: [...e.sizes.values()].reduce((n, x) => n + x, 0),
        sizes: [...e.sizes.entries()]
          .sort((a, b) => (e.order.indexOf(a[0]) + 1 || 99) - (e.order.indexOf(b[0]) + 1 || 99))
          .map(([size, qty]) => ({ size, qty })),
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      days,
      stock: { pieces, retail, cost, products: products.length },
      slow,
      reorder,
      sizes,
      missingAmharic: missingAm,
    });
  }),
);

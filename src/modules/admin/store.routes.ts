import { Router } from 'express';
import { ADDIS_OFFSET_MS, startOfAddisDay } from '../../lib/addisTime';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { onStockRestored } from '../alerts/backInStock';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { slugify } from '../../lib/slug';
import { saveImage, saveRaw, imageUrls } from '../../lib/storage';
import { requireOwner } from '../../middleware/auth';
import { imageUpload, videoUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { publicUser } from '../auth/auth.routes';
import { serializeCategory } from '../catalog/serialize';
import type { Settings } from '@prisma/client';
import { getSettings } from '../settings/settings.service';
import { AUTO_VERIFY_PROVIDERS } from '../payments/shegerpay';
import { bot } from '../telegram/bot';
import { createLinkCode } from '../telegram/linkCodes';

/** Categories, brands, inventory, customers, staff, settings, analytics. */
export const adminStoreRouter = Router();

// ─── Categories & brands ─────────────────────────────────

adminStoreRouter.get(
  '/categories',
  ah(async (_req, res) => {
    const categories = await prisma.category.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    res.json({ categories: categories.map(serializeCategory) });
  }),
);

const categorySchema = z.object({
  nameEn: z.string().trim().min(2).max(40),
  nameAm: z.string().trim().min(1).max(40),
  kind: z.enum(['APPAREL', 'FOOTWEAR', 'FRAGRANCE', 'ACCESSORY']),
  sizes: z.array(z.string().trim().min(1).max(12)).max(30).default([]),
  sortOrder: z.number().int().default(0),
});

adminStoreRouter.post(
  '/categories',
  requireOwner,
  validate(categorySchema),
  ah(async (req, res) => {
    const category = await prisma.category.create({ data: { ...req.body, slug: slugify(req.body.nameEn) } });
    res.status(201).json({ category: serializeCategory(category) });
  }),
);

adminStoreRouter.put(
  '/categories/:id',
  requireOwner,
  validate(categorySchema),
  ah(async (req, res) => {
    const category = await prisma.category.update({ where: { id: req.params.id }, data: req.body });
    res.json({ category: serializeCategory(category) });
  }),
);

adminStoreRouter.post(
  '/categories/:id/image',
  requireOwner,
  imageUpload.single('image'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Choose an image');
    const saved = await saveImage(req.file.buffer, 'site');
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: { imageUrl: imageUrls(saved.key).md },
    });
    res.json({ category: serializeCategory(category) });
  }),
);

adminStoreRouter.delete(
  '/categories/:id',
  requireOwner,
  ah(async (req, res) => {
    const used = await prisma.product.count({ where: { categoryId: req.params.id } });
    if (used) throw conflict('Move or delete the products in this category first', 'IN_USE');
    await prisma.category.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

adminStoreRouter.get(
  '/brands',
  ah(async (_req, res) => {
    res.json({ brands: await prisma.brand.findMany({ orderBy: { name: 'asc' } }) });
  }),
);

// ─── Inventory ───────────────────────────────────────────

adminStoreRouter.get(
  '/inventory/low-stock',
  validate(z.object({ threshold: z.coerce.number().int().min(0).max(100).default(2) }), 'query'),
  ah(async (req, res) => {
    const threshold = (req.query as unknown as { threshold: number }).threshold;
    const variants = await prisma.productVariant.findMany({
      where: { isActive: true, stock: { lte: threshold }, product: { status: 'ACTIVE' } },
      include: { product: { select: { id: true, nameEn: true, slug: true } } },
      orderBy: { stock: 'asc' },
      take: 200,
    });
    res.json({ variants });
  }),
);

adminStoreRouter.post(
  '/inventory/adjust',
  validate(z.object({ variantId: z.string(), delta: z.number().int().min(-10_000).max(10_000).refine((n) => n !== 0) })),
  ah(async (req, res) => {
    const { variantId, delta } = req.body as { variantId: string; delta: number };
    const variant = await prisma.$transaction(async (tx) => {
      const v = await tx.productVariant.findUnique({ where: { id: variantId } });
      if (!v) throw notFound('Variant not found');
      if (v.stock + delta < 0) throw badRequest('Stock cannot go below zero');
      await tx.stockMovement.create({ data: { variantId, delta, reason: delta > 0 ? 'RESTOCK' : 'ADJUST', actorId: req.user!.id } });
      return tx.productVariant.update({ where: { id: variantId }, data: { stock: { increment: delta } } });
    });
    if (delta > 0) onStockRestored([variantId]);
    res.json({ variant });
  }),
);

// ─── Customers ───────────────────────────────────────────

adminStoreRouter.get(
  '/customers',
  validate(
    z.object({ q: z.string().trim().max(80).optional(), page: z.coerce.number().int().min(1).default(1) }),
    'query',
  ),
  ah(async (req, res) => {
    const { q, page } = req.query as unknown as { q?: string; page: number };
    const take = 40;
    const where = {
      role: 'CUSTOMER' as const,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' as const } },
              { phone: { contains: q } },
              { telegramUsername: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
    ]);
    const stats = await prisma.order.groupBy({
      by: ['userId'],
      where: { userId: { in: users.map((u) => u.id) }, status: { not: 'CANCELLED' } },
      _count: true,
      _sum: { total: true },
      _max: { createdAt: true },
    });
    const byUser = new Map(stats.map((s) => [s.userId, s]));
    res.json({
      total,
      hasMore: page * take < total,
      customers: users.map((u) => {
        const s = byUser.get(u.id);
        return {
          ...publicUser(u),
          createdAt: u.createdAt,
          orders: s?._count ?? 0,
          spent: s?._sum.total ?? 0,
          lastOrderAt: s?._max.createdAt ?? null,
        };
      }),
    });
  }),
);

/**
 * Customer insights for a period: top customers (by money and by orders), new vs returning,
 * average order, and regulars who went quiet (worth a personal message).
 */
adminStoreRouter.get(
  '/customers/insights',
  validate(z.object({ period: z.enum(['week', 'month', 'all']).default('month') }), 'query'),
  ah(async (req, res) => {
    const { period } = req.query as unknown as { period: 'week' | 'month' | 'all' };
    const now = new Date();
    const since = period === 'week' ? new Date(now.getTime() - 7 * 86_400_000) : period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(0);
    const valid = { status: { not: 'CANCELLED' as const }, userId: { not: null } };

    const [inPeriod, allTime, newCustomers, subscribers] = await Promise.all([
      prisma.order.groupBy({ by: ['userId'], where: { ...valid, createdAt: { gte: since } }, _count: true, _sum: { total: true }, _max: { createdAt: true } }),
      prisma.order.groupBy({ by: ['userId'], where: valid, _count: true, _sum: { total: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
      prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: since } } }),
      prisma.user.count({ where: { role: 'CUSTOMER', newsOptIn: true, isActive: true, telegramId: { not: null } } }),
    ]);
    const first = new Map(allTime.map((a) => [a.userId!, a]));
    // Returning = bought before this period (all-time view: bought more than once)
    const returning = inPeriod.filter((p) => (period === 'all' ? p._count > 1 : (first.get(p.userId!)?._min.createdAt ?? now) < since)).length;
    const orders = inPeriod.reduce((n, p) => n + p._count, 0);
    const revenue = inPeriod.reduce((n, p) => n + (p._sum.total ?? 0), 0);

    const bySpend = [...inPeriod].sort((a, b) => (b._sum.total ?? 0) - (a._sum.total ?? 0)).slice(0, 10);
    const byOrders = [...inPeriod].sort((a, b) => b._count - a._count || (b._sum.total ?? 0) - (a._sum.total ?? 0)).slice(0, 10);
    const quietSince = new Date(now.getTime() - 45 * 86_400_000);
    const winBack = allTime
      .filter((a) => a._count >= 2 && a._max.createdAt! < quietSince)
      .sort((a, b) => (b._sum.total ?? 0) - (a._sum.total ?? 0))
      .slice(0, 8);

    const ids = [...new Set([...bySpend, ...byOrders, ...winBack].map((x) => x.userId!))];
    const users = new Map((await prisma.user.findMany({ where: { id: { in: ids } } })).map((u) => [u.id, u]));
    const row = (x: { userId: string | null; _count: number; _sum: { total: number | null }; _max: { createdAt: Date | null } }) => {
      const u = users.get(x.userId!);
      const all = first.get(x.userId!);
      return u
        ? {
            ...publicUser(u),
            telegramId: u.telegramId?.toString() ?? null,
            orders: x._count,
            spent: x._sum.total ?? 0,
            lastOrderAt: x._max.createdAt,
            ordersAllTime: all?._count ?? x._count,
          }
        : null;
    };
    res.set('Cache-Control', 'no-store');
    res.json({
      period,
      buyers: inPeriod.length,
      orders,
      revenue,
      avgOrder: orders ? Math.round(revenue / orders) : 0,
      newCustomers,
      returningPct: inPeriod.length ? Math.round((returning / inPeriod.length) * 100) : 0,
      subscribers,
      topBySpend: bySpend.map(row).filter(Boolean),
      topByOrders: byOrders.map(row).filter(Boolean),
      winBack: winBack.map(row).filter(Boolean),
    });
  }),
);

/** Announce one product to customers the owner picked (top customers, a few regulars…). */
adminStoreRouter.post(
  '/customers/announce',
  validate(z.object({ productId: z.string().min(1).max(40), userIds: z.array(z.string().min(1).max(40)).min(1).max(500), note: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const { startTargetedBroadcast } = await import('../telegram/broadcast');
    const b = await startTargetedBroadcast(req.body.productId, req.user!.id, req.body.userIds, req.body.note);
    res.status(201).json({ broadcast: { id: b.id, total: b.total } });
  }),
);

// ─── Staff (owner only) ──────────────────────────────────

adminStoreRouter.get(
  '/staff',
  requireOwner,
  ah(async (_req, res) => {
    const staff = await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'OWNER'] } }, orderBy: { createdAt: 'asc' } });
    res.json({ staff: staff.map((u) => ({ ...publicUser(u), isActive: u.isActive, createdAt: u.createdAt })) });
  }),
);

// New admins join through Telegram invites (staffInvites.ts) — no passwords to hand out.

adminStoreRouter.patch(
  '/staff/:id',
  requireOwner,
  validate(z.object({ isActive: z.boolean().optional(), password: z.string().min(8).max(200).optional(), fullName: z.string().trim().min(2).max(80).optional() })),
  ah(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') throw notFound('Admin not found');
    const user = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}),
        ...(req.body.fullName ? { fullName: req.body.fullName } : {}),
        ...(req.body.password ? { passwordHash: await bcrypt.hash(req.body.password, 12) } : {}),
      },
    });
    res.json({ staff: { ...publicUser(user), isActive: user.isActive } });
  }),
);

adminStoreRouter.delete(
  '/staff/:id',
  requireOwner,
  ah(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || target.role !== 'ADMIN') throw notFound('Admin not found');
    // Keep history (order events reference the user): demote and lock instead of deleting.
    await prisma.user.update({ where: { id: target.id }, data: { role: 'CUSTOMER', passwordHash: null, staffTelegramId: null, staffLinkCode: null, isActive: target.telegramId !== null } });
    void import('./staffInvites').then((m) => m.tellRevoked(target.staffTelegramId)).catch(() => undefined);
    res.json({ ok: true });
  }),
);

// ─── Settings (owner only) ───────────────────────────────

/** Settings as the owner sees them: the payment provider key is never sent back, only whether it's set. */
function ownerSettings(s: Settings) {
  const { paymentVerifyKey, ...rest } = s;
  return {
    ...rest,
    paymentVerifyKeySet: Boolean(paymentVerifyKey),
    paymentVerifyServerKey: !paymentVerifyKey && Boolean(env.SHEGERPAY_API_KEY),
    autoVerifyMethods: Object.keys(AUTO_VERIFY_PROVIDERS),
  };
}

/** Automatic payment checking: on/off and the owner's ShegerPay key. Off by default (manual). */
adminStoreRouter.put(
  '/settings/payment-verification',
  requireOwner,
  validate(
    z.object({
      enabled: z.boolean(),
      // undefined = keep, '' = remove, string = replace
      apiKey: z.string().trim().max(200).optional(),
    }),
  ),
  ah(async (req, res) => {
    const current = await getSettings();
    const { enabled, apiKey } = req.body as { enabled: boolean; apiKey?: string };
    const nextKey = apiKey === undefined ? current.paymentVerifyKey : apiKey || null;
    if (enabled && !nextKey && !env.SHEGERPAY_API_KEY) throw badRequest('Add the ShegerPay API key to turn on automatic checking', 'KEY_REQUIRED');
    const settings = await prisma.settings.update({
      where: { id: 'default' },
      data: { autoVerifyPayments: enabled, paymentVerifyKey: nextKey },
    });
    res.json({ settings: ownerSettings(settings) });
  }),
);

adminStoreRouter.get(
  '/settings',
  requireOwner,
  ah(async (_req, res) => {
    const [settings, paymentMethods, deliveryOptions] = await Promise.all([
      getSettings(),
      prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.deliveryOption.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    res.json({ settings: ownerSettings(settings), paymentMethods, deliveryOptions, telegram: { botConfigured: Boolean(bot), botUsername: env.TELEGRAM_BOT_USERNAME } });
  }),
);

const settingsSchema = z
  .object({
    storeName: z.string().trim().min(2).max(60),
    phone: z.string().trim().max(20),
    telegramInbox: z.string().trim().max(40).transform((s) => s.replace(/^@/, '')),
    telegramChannelUrl: z.string().trim().max(200),
    tikTokHandle: z.string().trim().max(40).transform((s) => s.replace(/^@/, '')),
    addressEn: z.string().trim().max(200),
    addressAm: z.string().trim().max(200),
    mapLat: z.number().min(-90).max(90).nullable(),
    mapLng: z.number().min(-180).max(180).nullable(),
    openingHours: z.string().trim().max(80),
    announcementEn: z.string().trim().max(140),
    announcementAm: z.string().trim().max(140),
    heroVideoUrl: z.string().trim().max(500).nullable(),
    heroImageUrl: z.string().trim().max(500).nullable(),
    partialPaymentEnabled: z.boolean(),
    channelAutoImport: z.boolean(),
    dailyReport: z.boolean(),
    reportHour: z.number().int().min(0).max(23),
    bagReminders: z.boolean(),
    loyaltyEnabled: z.boolean(),
    loyaltyPercent: z.number().int().min(1).max(20),
    referralEnabled: z.boolean(),
    referralReward: z.number().int().min(0).max(100_000),
    referralFriendDiscount: z.number().int().min(0).max(100_000),
    referralMinSubtotal: z.number().int().min(0).max(10_000_000),
    creditMaxPercent: z.number().int().min(5).max(100),
    exchangeDays: z.number().int().min(0).max(60),
    depositPercent: z.number().int().min(10).max(90),
    returnPolicyEn: z.string().trim().max(3000),
    returnPolicyAm: z.string().trim().max(3000),
  })
  .partial();

adminStoreRouter.put(
  '/settings',
  requireOwner,
  validate(settingsSchema),
  ah(async (req, res) => {
    await getSettings();
    const settings = await prisma.settings.update({ where: { id: 'default' }, data: req.body });
    res.json({ settings: ownerSettings(settings) });
  }),
);

adminStoreRouter.put(
  '/settings/payment-methods',
  requireOwner,
  validate(
    z.object({
      methods: z
        .array(
          z.object({
            id: z.string(),
            accountName: z.string().trim().max(80),
            accountNumber: z.string().trim().max(40),
            isEnabled: z.boolean(),
            sortOrder: z.number().int(),
          }),
        )
        .max(60),
    }),
  ),
  ah(async (req, res) => {
    const methods = req.body.methods as { id: string; accountName: string; accountNumber: string; isEnabled: boolean; sortOrder: number }[];
    for (const m of methods) {
      if (m.isEnabled && m.id !== 'cash' && !m.accountNumber) throw badRequest(`Add the account number for ${m.id} before enabling it`, 'ACCOUNT');
    }
    await prisma.$transaction(methods.map(({ id, ...data }) => prisma.paymentMethod.update({ where: { id }, data })));
    res.json({ paymentMethods: await prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }) });
  }),
);

adminStoreRouter.put(
  '/settings/delivery-options',
  requireOwner,
  validate(
    z.object({
      options: z
        .array(
          z.object({
            id: z.string(),
            nameEn: z.string().trim().min(2).max(60),
            nameAm: z.string().trim().min(1).max(60),
            noteEn: z.string().trim().max(120),
            noteAm: z.string().trim().max(120),
            fee: z.number().int().min(0).max(100_000).nullable(),
            isEnabled: z.boolean(),
            sortOrder: z.number().int(),
          }),
        )
        .max(20),
    }),
  ),
  ah(async (req, res) => {
    const options = req.body.options as { id: string }[];
    await prisma.$transaction(options.map(({ id, ...data }) => prisma.deliveryOption.update({ where: { id }, data })));
    res.json({ deliveryOptions: await prisma.deliveryOption.findMany({ orderBy: { sortOrder: 'asc' } }) });
  }),
);

adminStoreRouter.post(
  '/settings/hero',
  requireOwner,
  videoUpload.single('video'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Choose a video');
    const url = await saveRaw(req.file.buffer, 'site', req.file.mimetype === 'video/webm' ? 'webm' : 'mp4', req.file.mimetype);
    const settings = await prisma.settings.update({ where: { id: 'default' }, data: { heroVideoUrl: url } });
    res.json({ settings: ownerSettings(settings) });
  }),
);

adminStoreRouter.post(
  '/settings/hero-image',
  requireOwner,
  imageUpload.single('image'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Choose an image');
    const saved = await saveImage(req.file.buffer, 'site');
    const settings = await prisma.settings.update({ where: { id: 'default' }, data: { heroImageUrl: imageUrls(saved.key).lg } });
    res.json({ settings: ownerSettings(settings) });
  }),
);

/** One-time code to link the admin group or channel to the bot ("/link CODE"). */
adminStoreRouter.post(
  '/settings/telegram-link',
  requireOwner,
  validate(z.object({ purpose: z.enum(['admin', 'channel']) })),
  ah(async (req, res) => {
    res.json({ code: await createLinkCode(req.body.purpose), expiresInMinutes: 15, botUsername: env.TELEGRAM_BOT_USERNAME });
  }),
);

// ─── Analytics ───────────────────────────────────────────


adminStoreRouter.get(
  '/analytics',
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), 'query'),
  ah(async (req, res) => {
    const days = (req.query as unknown as { days: number }).days;
    const today = startOfAddisDay();
    const since = new Date(today.getTime() - (days - 1) * 86400_000);
    const prevSince = new Date(since.getTime() - days * 86400_000);
    const notCancelled = { status: { not: 'CANCELLED' as const } };
    const valid = { createdAt: { gte: since }, ...notCancelled };

    const [totals, prev, todayAgg, byDay, top, bySource, pending, lowStock, toPrepare, onTheWay, drafts] = await Promise.all([
      prisma.order.aggregate({ where: valid, _sum: { total: true, costTotal: true, amountPaid: true }, _count: true }),
      prisma.order.aggregate({ where: { createdAt: { gte: prevSince, lt: since }, ...notCancelled }, _sum: { total: true }, _count: true }),
      prisma.order.aggregate({ where: { createdAt: { gte: today }, ...notCancelled }, _sum: { total: true }, _count: true }),
      prisma.$queryRaw<{ day: Date; revenue: bigint; orders: bigint }[]>`
        SELECT date_trunc('day', "createdAt" + interval '3 hours') AS day, SUM("total")::bigint AS revenue, COUNT(*)::bigint AS orders
        FROM "Order" WHERE "createdAt" >= ${since} AND "status" <> 'CANCELLED'
        GROUP BY 1 ORDER BY 1`,
      prisma.orderItem.groupBy({
        by: ['productId', 'productName'],
        where: { order: valid },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 6,
      }),
      prisma.order.groupBy({ by: ['source'], where: valid, _count: true, _sum: { total: true } }),
      prisma.order.count({ where: { paymentStatus: 'SUBMITTED', ...notCancelled } }),
      prisma.productVariant.count({ where: { isActive: true, stock: { lte: 2 }, product: { status: 'ACTIVE' } } }),
      prisma.order.count({ where: { status: { in: ['CONFIRMED', 'PACKING'] } } }),
      prisma.order.count({ where: { status: 'OUT_FOR_DELIVERY' } }),
      prisma.product.count({ where: { status: 'DRAFT' } }),
    ]);

    // Continuous series: one entry per day, zeros included
    const byKey = new Map(byDay.map((d) => [d.day.toISOString().slice(0, 10), d]));
    const series = Array.from({ length: days }, (_, i) => {
      const key = new Date(since.getTime() + ADDIS_OFFSET_MS + i * 86400_000).toISOString().slice(0, 10);
      const row = byKey.get(key);
      return { day: key, revenue: row ? Number(row.revenue) : 0, orders: row ? Number(row.orders) : 0 };
    });

    const covers = await prisma.productImage.findMany({
      where: { productId: { in: top.map((t) => t.productId) }, sortOrder: 0 },
      select: { productId: true, key: true },
    });
    const coverOf = new Map(covers.map((c) => [c.productId, imageUrls(c.key).sm]));

    const revenue = totals._sum.total ?? 0;
    const prevRevenue = prev._sum.total ?? 0;
    res.json({
      days,
      revenue,
      orders: totals._count,
      averageOrder: totals._count ? Math.round(revenue / totals._count) : 0,
      profit: revenue - (totals._sum.costTotal ?? 0),
      collected: totals._sum.amountPaid ?? 0,
      previous: { revenue: prevRevenue, orders: prev._count },
      today: { revenue: todayAgg._sum.total ?? 0, orders: todayAgg._count },
      attention: { paymentsToCheck: pending, toPrepare, onTheWay, lowStock, drafts },
      // kept for older clients
      pendingReview: pending,
      lowStock,
      byDay: series,
      topProducts: top.map((t) => ({
        productId: t.productId,
        name: t.productName,
        quantity: t._sum.quantity ?? 0,
        image: coverOf.get(t.productId) ?? null,
      })),
      bySource: bySource.map((s) => ({ source: s.source, orders: s._count, revenue: s._sum.total ?? 0 })),
    });
  }),
);


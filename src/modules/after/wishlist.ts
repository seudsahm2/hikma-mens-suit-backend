/**
 * Saved items + price-drop alerts. When a saved product gets cheaper than the price the customer
 * last saw, they get one Telegram message (and that price becomes the new reference).
 */
import { Router } from 'express';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah, notFound } from '../../lib/http';
import { requireAuth } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { productInclude, serializeProductCard } from '../catalog/serialize';
import { bot, shopUrl } from '../telegram/bot';
import { birr, escapeHtml, telegramPhoto } from '../telegram/media';

/** What the customer pays for this product right now (cheapest active variant). */
async function currentPrice(productId: string) {
  const p = await prisma.product.findUnique({ where: { id: productId }, include: { variants: { where: { isActive: true } } } });
  if (!p) return null;
  const prices = p.variants.map((v) => v.price ?? p.basePrice);
  return { product: p, price: prices.length ? Math.min(...prices) : p.basePrice };
}

export const wishlistRouter = Router();
wishlistRouter.use(requireAuth);

/** Saved products (cards) — newest first. */
wishlistRouter.get(
  '/',
  ah(async (req, res) => {
    const items = await prisma.wishlistItem.findMany({
      where: { userId: req.user!.id, product: { status: { not: 'ARCHIVED' } } },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: productInclude } },
      take: 100,
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      products: items.filter((i) => i.product.status === 'ACTIVE').map((i) => serializeProductCard(i.product)),
      ids: items.map((i) => i.productId),
    });
  }),
);

wishlistRouter.post(
  '/',
  limiter({ windowMs: 60_000, limit: 60 }),
  validate(z.object({ productId: z.string().min(1).max(40) })),
  ah(async (req, res) => {
    const now = await currentPrice(req.body.productId);
    if (!now || now.product.status !== 'ACTIVE') throw notFound('Product not found');
    await prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: req.user!.id, productId: now.product.id } },
      create: { userId: req.user!.id, productId: now.product.id, priceSeen: now.price },
      update: {},
    });
    res.status(201).json({ ok: true });
  }),
);

/** Items saved on this device before signing in. */
wishlistRouter.post(
  '/merge',
  validate(z.object({ productIds: z.array(z.string().min(1).max(40)).max(100) })),
  ah(async (req, res) => {
    for (const productId of req.body.productIds as string[]) {
      const now = await currentPrice(productId);
      if (!now || now.product.status !== 'ACTIVE') continue;
      await prisma.wishlistItem.upsert({
        where: { userId_productId: { userId: req.user!.id, productId } },
        create: { userId: req.user!.id, productId, priceSeen: now.price },
        update: {},
      });
    }
    res.json({ ok: true });
  }),
);

wishlistRouter.delete(
  '/:productId',
  ah(async (req, res) => {
    await prisma.wishlistItem.deleteMany({ where: { userId: req.user!.id, productId: req.params.productId } });
    res.json({ ok: true });
  }),
);

/** Call after a product's price may have changed (admin save). Never throws. */
export async function checkPriceDrop(productId: string) {
  try {
    const now = await currentPrice(productId);
    if (!now || now.product.status !== 'ACTIVE') return;
    // Price went up: quietly move the reference so a later drop is measured from here
    await prisma.wishlistItem.updateMany({ where: { productId, priceSeen: { lt: now.price } }, data: { priceSeen: now.price } });
    const dropped = await prisma.wishlistItem.findMany({
      where: { productId, priceSeen: { gt: now.price } },
      include: { user: { select: { telegramId: true, languageCode: true } } },
      take: 500,
    });
    if (!dropped.length) return;
    await prisma.wishlistItem.updateMany({ where: { productId, priceSeen: { gt: now.price } }, data: { priceSeen: now.price } });
    if (!bot) return;
    const img = await prisma.productImage.findFirst({ where: { productId }, orderBy: { sortOrder: 'asc' } });
    for (const w of dropped) {
      if (!w.user.telegramId) continue;
      const am = w.user.languageCode === 'am';
      const name = escapeHtml((am && now.product.nameAm) || now.product.nameEn);
      const caption = am
        ? `💸 <b>ዋጋ ቀነሰ</b>\n${name}\n<b>${birr(now.price)}</b>  <s>${birr(w.priceSeen)}</s>`
        : `💸 <b>Price drop</b> on something you saved\n${name}\n<b>${birr(now.price)}</b>  <s>${birr(w.priceSeen)}</s>`;
      const kb = new InlineKeyboard().webApp(am ? '🛍  ይመልከቱ' : '🛍  View', shopUrl(`/p/${now.product.slug}`));
      try {
        if (img) await bot.api.sendPhoto(Number(w.user.telegramId), telegramPhoto(img.key, 'md'), { caption, parse_mode: 'HTML', reply_markup: kb });
        else await bot.api.sendMessage(Number(w.user.telegramId), caption, { parse_mode: 'HTML', reply_markup: kb });
      } catch {
        /* blocked the bot / never started it */
      }
      await new Promise((r) => setTimeout(r, 50)); // stay well under Telegram's rate limit
    }
    logger.info({ productId, told: dropped.length }, 'price drop announced');
  } catch (err) {
    logger.warn({ err, productId }, 'price drop check failed');
  }
}

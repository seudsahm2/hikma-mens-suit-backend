/**
 * Reviews from real buyers only: a customer can review a product once they have an order with it
 * that was delivered or picked up. One review per customer per product (editing replaces it).
 */
import { InlineKeyboard } from 'grammy';
import type { Review, ReviewPhoto, User } from '@prisma/client';
import { addisHour } from '../../lib/addisTime';
import { conflict } from '../../lib/http';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { imageUrls } from '../../lib/storage';
import { bot, shopUrl } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

const RECEIVED = ['DELIVERED', 'PICKED_UP'] as const;
const WRITE_WINDOW_DAYS = 120;

/** "Abebe K." — first name and initial only. */
export function displayName(fullName: string) {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const last = rest.at(-1);
  return `${first ?? 'Customer'}${last ? ` ${last[0]!.toUpperCase()}.` : ''}`;
}

export function serializeReview(r: Review & { photos: ReviewPhoto[]; user: Pick<User, 'fullName'> }) {
  return {
    id: r.id,
    rating: r.rating,
    text: r.text,
    size: r.size,
    name: displayName(r.user.fullName),
    photos: [...r.photos].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ id: p.id, urls: imageUrls(p.key) })),
    createdAt: r.createdAt,
  };
}

/** The order that proves this customer received the product (most recent), or null. */
export async function receivedOrderItem(userId: string, productId: string) {
  return prisma.orderItem.findFirst({
    where: {
      productId,
      order: { userId, status: { in: [...RECEIVED] }, createdAt: { gte: new Date(Date.now() - WRITE_WINDOW_DAYS * 86400_000) } },
    },
    orderBy: { order: { createdAt: 'desc' } },
    select: { orderId: true, size: true },
  });
}

export async function assertCanReview(userId: string, productId: string) {
  const item = await receivedOrderItem(userId, productId);
  if (!item) throw conflict('You can review this after you receive it', 'NOT_RECEIVED');
  return item;
}

/** Keeps Product.ratingAvg / ratingCount in step with its published reviews. */
export async function recomputeRating(productId: string) {
  const agg = await prisma.review.aggregate({ where: { productId, status: 'published' }, _avg: { rating: true }, _count: true });
  await prisma.product.update({ where: { id: productId }, data: { ratingAvg: agg._avg.rating, ratingCount: agg._count } });
}

/** Products this customer received but hasn't reviewed yet. */
export async function toReview(userId: string) {
  const [items, reviewed] = await Promise.all([
    prisma.orderItem.findMany({
      where: { order: { userId, status: { in: [...RECEIVED] }, createdAt: { gte: new Date(Date.now() - WRITE_WINDOW_DAYS * 86400_000) } } },
      orderBy: { order: { createdAt: 'desc' } },
      include: { order: { select: { orderNumber: true } } },
      take: 40,
    }),
    prisma.review.findMany({ where: { userId }, select: { productId: true } }),
  ]);
  const done = new Set(reviewed.map((r) => r.productId));
  const open = items.filter((i) => !done.has(i.productId) && done.add(i.productId)); // also de-duplicates
  const products = await prisma.product.findMany({
    where: { id: { in: open.map((i) => i.productId) }, status: { not: 'ARCHIVED' } },
    select: { id: true, slug: true, nameEn: true, nameAm: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return open.flatMap((i) => {
    const p = byId.get(i.productId);
    return p
      ? [
          {
            productId: p.id,
            slug: p.slug,
            nameEn: p.nameEn,
            nameAm: p.nameAm,
            size: i.size,
            image: i.imageKey ? imageUrls(i.imageKey).sm : null,
            orderNumber: i.order.orderNumber,
          },
        ]
      : [];
  });
}

// ─── Asking for a review on Telegram ─────────────────────

/**
 * About a day after an order is delivered / picked up, the customer gets one message asking for a
 * review (daytime only). Claimed with a conditional update, so it's never sent twice.
 */
export async function askForReviews(now = new Date()) {
  if (!bot) return 0;
  const hour = addisHour(now);
  if (hour < 10 || hour >= 20) return 0;
  const due = await prisma.order.findMany({
    where: {
      status: { in: [...RECEIVED] },
      source: { not: 'COUNTER' },
      reviewAskedAt: null,
      telegramChatId: { not: null },
      updatedAt: { lte: new Date(now.getTime() - 20 * 3600_000), gte: new Date(now.getTime() - 14 * 86400_000) },
    },
    include: { items: true, user: { select: { languageCode: true, id: true } } },
    take: 20,
  });
  let sent = 0;
  for (const o of due) {
    const claimed = await prisma.order.updateMany({ where: { id: o.id, reviewAskedAt: null }, data: { reviewAskedAt: now, updatedAt: o.updatedAt } });
    if (!claimed.count || !o.user) continue;
    const pending = await prisma.review.count({ where: { userId: o.user.id, productId: { in: o.items.map((i) => i.productId) } } });
    if (pending >= new Set(o.items.map((i) => i.productId)).size) continue; // already reviewed everything
    const am = o.user.languageCode === 'am';
    const first = escapeHtml(o.items[0]!.productName);
    const text = am
      ? `👋 <b>${first}</b> እንዴት ነው? በአንድ ደቂቃ ደረጃ ይስጡ — ሌሎች ወንዶች እንዲመርጡ ይረዳል።`
      : `👋 How do you like your <b>${first}</b>? Rate it in a minute — it helps other men choose.`;
    try {
      await bot.api.sendMessage(Number(o.telegramChatId), text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().webApp(am ? '⭐  ደረጃ ይስጡ' : '⭐  Rate it', shopUrl(`/orders/${o.orderNumber}?review=1`)),
      });
      sent++;
    } catch (err) {
      logger.debug({ err: (err as Error).message, order: o.orderNumber }, 'review request not delivered');
    }
  }
  return sent;
}

export function startReviewRequestWorker() {
  const timer = setInterval(() => {
    askForReviews().then(
      (n) => n && logger.info({ sent: n }, 'review requests sent'),
      (err) => logger.warn({ err }, 'review requests failed'),
    );
  }, 15 * 60_000);
  return () => clearInterval(timer);
}

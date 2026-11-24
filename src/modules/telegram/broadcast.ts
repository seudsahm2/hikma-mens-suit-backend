import { InlineKeyboard } from 'grammy';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { conflict, HttpError, notFound } from '../../lib/http';
import { bot, shopUrl } from './bot';
import { birr, escapeHtml, telegramPhoto } from './media';

/**
 * New-arrival announcements to customers who opted in (bot button, /news, or the website toggle).
 * A Broadcast row is created by the owner; a worker sends it in batches of 25 (≈20 messages/s, under
 * Telegram's 30/s), saving a cursor after each batch so a restart continues where it stopped.
 * Customers who blocked the bot are switched off automatically.
 */
const BATCH = 25;
const GAP_MS = 50;
const subscriberWhere = { newsOptIn: true, isActive: true, telegramId: { not: null } } as const;

export const subscriberCount = () => prisma.user.count({ where: subscriberWhere });

export async function startBroadcast(productId: string, actorId: string | null, force = false) {
  if (!bot) throw new HttpError(503, 'Telegram bot is not configured', 'TELEGRAM_DISABLED');
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { images: true } });
  if (!product) throw notFound('Product not found');
  if (product.status !== 'ACTIVE') throw conflict('Put the product on sale before announcing it', 'NOT_ACTIVE');
  if (!product.images.length) throw conflict('Add a photo before announcing it', 'NO_IMAGES');

  const recent = await prisma.broadcast.findFirst({
    where: { productId, status: { not: 'cancelled' }, createdAt: { gt: new Date(Date.now() - 7 * 86400_000) } },
  });
  if (recent && !force) throw conflict('This product was already announced this week', 'ALREADY_ANNOUNCED');

  const total = await subscriberCount();
  if (!total) throw conflict('No customers have subscribed to new arrivals yet', 'NO_SUBSCRIBERS');
  return prisma.broadcast.create({ data: { productId, createdById: actorId, total } });
}

/** Sends the next batch of the oldest running broadcast. Returns messages sent. */
export async function processBroadcasts(): Promise<number> {
  if (!bot) return 0;
  const b = await prisma.broadcast.findFirst({
    where: { status: 'sending' },
    orderBy: { createdAt: 'asc' },
    include: { product: { include: { brand: true, images: { orderBy: { sortOrder: 'asc' }, take: 1 }, variants: true } } },
  });
  if (!b) return 0;
  const p = b.product;
  const image = p.images[0];
  if (p.status !== 'ACTIVE' || !image) {
    await prisma.broadcast.update({ where: { id: b.id }, data: { status: 'cancelled', finishedAt: new Date() } });
    return 0;
  }

  const users = await prisma.user.findMany({
    where: { ...subscriberWhere, ...(b.cursor ? { id: { gt: b.cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: BATCH,
    select: { id: true, telegramId: true, languageCode: true },
  });
  if (!users.length) {
    await prisma.broadcast.update({ where: { id: b.id }, data: { status: 'done', finishedAt: new Date() } });
    logger.info({ id: b.id, sent: b.sentCount, failed: b.failedCount }, 'broadcast finished');
    return 0;
  }

  const prices = p.variants.filter((v) => v.isActive).map((v) => v.price ?? p.basePrice);
  const price = birr(prices.length ? Math.min(...prices) : p.basePrice);
  const name = escapeHtml([p.brand?.name, p.nameEn].filter(Boolean).join(' · '));
  const nameAm = escapeHtml([p.brand?.name, p.nameAm || p.nameEn].filter(Boolean).join(' · '));

  let sent = 0;
  let failed = 0;
  for (const u of users) {
    const am = u.languageCode === 'am';
    try {
      await bot.api.sendPhoto(u.telegramId!.toString(), telegramPhoto(image.key, 'md'), {
        caption: am
          ? `🆕 <b>አዲስ ገብቷል</b>\n${nameAm}\n${price}\n\n<i>ለማቆም /stop</i>`
          : `🆕 <b>New in</b>\n${name}\n${price}\n\n<i>Turn off: /stop</i>`,
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().webApp(am ? '🛍  ይመልከቱ' : '🛍  View', shopUrl(`/p/${p.slug}`)),
      });
      sent++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      // Blocked the bot / deleted account: stop sending to them
      if (/blocked|deactivated|chat not found|403/i.test(message)) {
        await prisma.user.update({ where: { id: u.id }, data: { newsOptIn: false } }).catch(() => undefined);
      } else {
        logger.warn({ err: message, userId: u.id }, 'broadcast message failed');
      }
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  await prisma.broadcast.update({
    where: { id: b.id },
    data: { cursor: users.at(-1)!.id, sentCount: { increment: sent }, failedCount: { increment: failed } },
  });
  return sent;
}

export function startBroadcastWorker() {
  if (!bot) return () => undefined;
  let running = false;
  const id = setInterval(() => {
    if (running) return;
    running = true;
    processBroadcasts()
      .catch((err) => logger.warn({ err }, 'broadcast worker error'))
      .finally(() => (running = false));
  }, 2000);
  return () => clearInterval(id);
}

/** Turns new-arrival messages on/off for a Telegram user, creating the customer if needed. */
export async function setNewsOptIn(from: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }, on: boolean) {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Customer';
  await prisma.user.upsert({
    where: { telegramId: BigInt(from.id) },
    create: {
      telegramId: BigInt(from.id),
      telegramUsername: from.username,
      fullName,
      languageCode: from.language_code === 'am' ? 'am' : 'en',
      newsOptIn: on,
      newsOptInAt: on ? new Date() : null,
    },
    update: { newsOptIn: on, newsOptInAt: on ? new Date() : null },
  });
}

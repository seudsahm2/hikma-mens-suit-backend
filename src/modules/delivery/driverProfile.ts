/**
 * Delivery people: customer ratings + the owner's driver profile (current job, stats, history).
 *
 * Rating: after a confirmed delivery the customer is asked once on Telegram (⭐ 1–5) and can also
 * rate on the order page. One rating per order; stored on the order (Order.driverRating) so every
 * number in the profile is traceable to a real delivery.
 */
import { InlineKeyboard } from 'grammy';
import { prisma } from '../../lib/prisma';
import { conflict, notFound } from '../../lib/http';
import { logger } from '../../lib/logger';
import { bot } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

const DAY = 86_400_000;

export async function rateDelivery(orderId: string, stars: number, by: { userId?: string; telegramId?: number }, note?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order not found');
  const mine = (by.userId && order.userId === by.userId) || (by.telegramId && order.telegramChatId?.toString() === String(by.telegramId));
  if (!mine) throw notFound('Order not found');
  if (order.status !== 'DELIVERED' || !order.driverId) throw conflict('Only delivered orders can be rated', 'NOT_DELIVERED');
  if (order.driverRating) throw conflict('Thanks — you already rated this delivery', 'ALREADY');
  const s = Math.max(1, Math.min(5, Math.round(stars)));
  await prisma.order.update({ where: { id: orderId }, data: { driverRating: s, driverRatingNote: note?.trim() || null, driverRatedAt: new Date() } });
  // A low rating is something the owner should hear about right away
  if (s <= 2) {
    const d = await prisma.driver.findUnique({ where: { id: order.driverId } });
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    if (bot && settings?.adminChatId && d) {
      await bot.api
        .sendMessage(settings.adminChatId, `⚠️ ${'⭐'.repeat(s)} for <b>${escapeHtml(d.name)}</b> on <b>${escapeHtml(order.orderNumber)}</b>${note ? ` — “${escapeHtml(note.slice(0, 200))}”` : ''}`, { parse_mode: 'HTML' })
        .catch(() => undefined);
    }
  }
  return s;
}

/** Asked once, right after a confirmed delivery (Telegram customers). */
export async function askDeliveryRating(orderId: string) {
  if (!bot) return;
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { driver: true, user: true } });
  if (!o?.driver || !o.telegramChatId || o.driverRating) return;
  const am = o.user?.languageCode === 'am';
  const kb = new InlineKeyboard();
  for (let n = 1; n <= 5; n++) kb.text(`${n} ⭐`, `drt:${o.id}:${n}`);
  await bot.api
    .sendMessage(
      o.telegramChatId.toString(),
      am ? `🛵 ${o.driver.name.split(' ')[0]} ትዕዛዝዎን እንዴት አደረሰ? (${o.orderNumber})` : `🛵 How was the delivery by ${o.driver.name.split(' ')[0]}? (${o.orderNumber})`,
      { reply_markup: kb },
    )
    .catch((err) => logger.warn({ err: (err as Error).message }, 'rating ask failed'));
}

if (bot) {
  bot.callbackQuery(/^drt:([a-z0-9]+):([1-5])$/, async (ctx) => {
    try {
      const s = await rateDelivery(ctx.match[1]!, Number(ctx.match[2]), { telegramId: ctx.from.id });
      await ctx.answerCallbackQuery({ text: 'Thank you! 🙏' });
      await ctx.editMessageText(`${ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ''}\n\n${'⭐'.repeat(s)} — thank you!`).catch(() => undefined);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190) });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    }
  });
}

// ─── Owner: driver profile ───────────────────────────────

export async function driverProfile(driverId: string) {
  const d = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!d) throw notFound('Driver not found');
  const now = Date.now();
  const weekAgo = new Date(now - 7 * DAY);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [delivered, offers, current, cash] = await Promise.all([
    prisma.order.findMany({
      where: { driverId, status: 'DELIVERED' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        customerName: true,
        area: true,
        city: true,
        total: true,
        cashCollected: true,
        updatedAt: true,
        driverRating: true,
        driverRatingNote: true,
        deliveryOffers: { where: { driverId, status: 'completed' }, select: { handedAt: true }, take: 1 },
        events: { where: { type: 'status_delivered' }, select: { createdAt: true }, take: 1 },
      },
    }),
    prisma.deliveryOffer.groupBy({ by: ['status'], where: { driverId }, _count: true }),
    prisma.order.findFirst({
      where: { driverId, status: { in: ['PACKING', 'CONFIRMED', 'OUT_FOR_DELIVERY'] } },
      orderBy: { updatedAt: 'desc' },
      include: { items: true, deliveryOffers: { where: { driverId }, orderBy: { offeredAt: 'desc' }, take: 1 } },
    }),
    prisma.order.aggregate({ where: { cashDriverId: driverId, cashSettledAt: null, cashCollected: { gt: 0 } }, _sum: { cashCollected: true }, _count: true }),
  ]);

  const deliveredAt = (o: (typeof delivered)[number]) => o.events[0]?.createdAt ?? o.updatedAt;
  const minutes = delivered
    .map((o) => (o.deliveryOffers[0]?.handedAt ? (deliveredAt(o).getTime() - o.deliveryOffers[0].handedAt.getTime()) / 60_000 : null))
    .filter((m): m is number => m !== null && m > 0 && m < 600);
  const rated = delivered.filter((o) => o.driverRating);
  const count = (status: string) => offers.find((o) => o.status === status)?._count ?? 0;
  const handed = current?.deliveryOffers[0]?.handedAt ?? null;

  return {
    driver: {
      id: d.id,
      name: d.name,
      phone: d.phone,
      isActive: d.isActive,
      linked: Boolean(d.telegramId),
      isOnline: d.isOnline,
      since: d.createdAt,
      locationAt: d.locationAt,
      mapUrl: d.lat != null && d.lng != null ? `https://maps.google.com/?q=${d.lat},${d.lng}` : null,
    },
    stats: {
      deliveredAll: delivered.length,
      deliveredWeek: delivered.filter((o) => deliveredAt(o) >= weekAgo).length,
      deliveredMonth: delivered.filter((o) => deliveredAt(o) >= monthStart).length,
      rating: rated.length ? Math.round((rated.reduce((n, o) => n + o.driverRating!, 0) / rated.length) * 10) / 10 : null,
      ratingCount: rated.length,
      avgMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
      accepted: count('accepted') + count('completed'),
      declined: count('declined'),
      missed: count('expired'),
      cashHolding: cash._sum.cashCollected ?? 0,
      cashOrders: cash._count,
      valueDelivered: delivered.reduce((n, o) => n + o.total, 0),
    },
    current: current
      ? {
          id: current.id,
          orderNumber: current.orderNumber,
          status: current.status,
          stage: current.status === 'OUT_FOR_DELIVERY' ? 'on_the_way' : current.deliveryOffers[0]?.status === 'accepted' ? 'coming_to_shop' : 'offered',
          customerName: current.customerName,
          customerPhone: current.customerPhone,
          address: [current.area, current.landmark, current.city].filter(Boolean).join(', ') || current.deliveryLabel,
          mapUrl: current.lat != null && current.lng != null ? `https://maps.google.com/?q=${current.lat},${current.lng}` : null,
          items: current.items.map((i) => ({ name: i.productName, size: i.size, color: i.color, quantity: i.quantity })),
          total: current.total,
          toCollect: Math.max(0, current.total - current.amountPaid),
          etaMinutes: current.deliveryOffers[0]?.etaMinutes ?? null,
          handedAt: handed,
        }
      : null,
    history: delivered.slice(0, 50).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      area: [o.area, o.city].filter(Boolean).join(', '),
      total: o.total,
      collected: o.cashCollected,
      at: deliveredAt(o),
      minutes: o.deliveryOffers[0]?.handedAt ? Math.round((deliveredAt(o).getTime() - o.deliveryOffers[0].handedAt.getTime()) / 60_000) : null,
      rating: o.driverRating,
      note: o.driverRatingNote,
    })),
  };
}


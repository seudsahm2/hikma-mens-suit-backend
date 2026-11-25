/**
 * Dispatch: offer → accept → hand over → on the way → code.
 *
 *  1. Staff tap "Find nearest driver" (or pick one). The best driver is chosen: online, not busy,
 *     closest to the shop by their Telegram live location.
 *  2. The driver gets a job offer: ✅ Coming 15 min / ✅ Coming 30 min / ❌ Can't now.
 *     No answer in OFFER_MINUTES, or "can't" → next nearest driver (automatic dispatch, up to
 *     MAX_AUTO_TRIES drivers). Staff are told at every step.
 *  3. When the driver arrives and takes the items, STAFF tap "Handed over" → order is "On the way",
 *     the customer gets the delivery code, the driver gets the delivery card (with the code entry).
 */
import { InlineKeyboard } from 'grammy';
import type { Driver } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { conflict, notFound } from '../../lib/http';
import { bot } from '../telegram/bot';
import { birr, escapeHtml } from '../telegram/media';
import { logActivity } from '../admin/activity';
import { BTN_LIVE, BTN_OFFLINE, BTN_ONLINE, LIVE_HOWTO, driverKeyboard, driverSend, driverSendLocation } from './driverChat';

export const OFFER_MINUTES = 5;
const MAX_AUTO_TRIES = 3;
const LOCATION_FRESH_MIN = 30;

/** Distance in km between two points. */
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function shopPoint() {
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  return s?.mapLat != null && s?.mapLng != null ? { lat: s.mapLat, lng: s.mapLng } : null;
}

/** Drivers with a job offered/accepted, or an order on the way. */
/** Busy drivers → the order keeping them busy (shown in the admin so a stuck order is easy to find). */
async function busyDriverIds() {
  const [offers, onTheWay] = await Promise.all([
    // Only offers on orders that are still open (an offer left behind by a finished/cancelled order doesn't count)
    prisma.deliveryOffer.findMany({
      where: { status: { in: ['offered', 'accepted'] }, order: { status: { in: ['PENDING', 'CONFIRMED', 'PACKING'] } } },
      select: { driverId: true, order: { select: { id: true, orderNumber: true } } },
    }),
    prisma.order.findMany({ where: { status: 'OUT_FOR_DELIVERY', driverId: { not: null } }, select: { driverId: true, id: true, orderNumber: true } }),
  ]);
  const map = new Map<string, { id: string; orderNumber: string }>();
  for (const o of offers) map.set(o.driverId, o.order);
  for (const o of onTheWay) map.set(o.driverId!, { id: o.id, orderNumber: o.orderNumber });
  return map;
}

export function locationFresh(d: Pick<Driver, 'locationAt'>) {
  return Boolean(d.locationAt && Date.now() - d.locationAt.getTime() < LOCATION_FRESH_MIN * 60_000);
}

/** Every driver with status for the admin: online, busy, distance to the shop. */
export async function driverBoard() {
  const [drivers, busy, shop] = await Promise.all([prisma.driver.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] }), busyDriverIds(), shopPoint()]);
  return drivers.map((d) => {
    const fresh = locationFresh(d);
    return {
      driver: d,
      busy: busy.has(d.id),
      busyWith: busy.get(d.id) ?? null,
      fresh,
      distanceKm: shop && d.lat != null && d.lng != null ? Math.round(km(shop, { lat: d.lat, lng: d.lng }) * 10) / 10 : null,
    };
  });
}

/** Linked drivers, best first: free + online, then fresh location, then nearest to the shop. */
export async function rankedDrivers() {
  const board = (await driverBoard()).filter((b) => b.driver.isActive && b.driver.telegramId);
  const ready = (b: (typeof board)[number]) => (b.driver.isOnline && !b.busy ? 0 : 1);
  return board.sort((a, b) => ready(a) - ready(b) || rank(a, b));
}

/** Best available driver for an order: online, linked, not busy, nearest to the shop (fresh location first). */
async function pickDriver(exclude: Set<string>) {
  const board = await driverBoard();
  const candidates = board.filter((b) => b.driver.isActive && b.driver.telegramId && b.driver.isOnline && !b.busy && !exclude.has(b.driver.id));
  candidates.sort(rank);
  return candidates[0] ?? null;
}

type BoardRow = Awaited<ReturnType<typeof driverBoard>>[number];
function rank(a: BoardRow, b: BoardRow) {
  if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
  if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
  if (a.distanceKm !== null) return -1;
  if (b.distanceKm !== null) return 1;
  return (b.driver.locationAt?.getTime() ?? 0) - (a.driver.locationAt?.getTime() ?? 0);
}

async function tellStaff(text: string, kb?: InlineKeyboard) {
  if (!bot) return;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (s?.adminChatId) await bot.api.sendMessage(s.adminChatId, text, { parse_mode: 'HTML', ...(kb ? { reply_markup: kb } : {}) }).catch(() => undefined);
}

/** One-tap "pick another driver" under staff messages (opens the nearest-first list on the bot). */
const pickAgain = (orderId: string) => new InlineKeyboard().text('🛵 Choose another driver', `o:${orderId}:pick`);

function assertDispatchable(o: { status: string; deliveryOptionId: string; cancelAt?: Date | null }) {
  if (o.cancelAt) throw conflict('This order is about to be cancelled — undo the cancel first', 'CANCEL_PENDING');
  if (o.deliveryOptionId === 'pickup') throw conflict('This order is picked up at the shop', 'PICKUP');
  if (['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(o.status)) throw conflict('This order is already on the way or finished', 'FINISHED');
}

/** Keeps the order's Telegram cards in step with the driver state (buttons + driver line). */
function refreshCards(orderId: string) {
  void import('../telegram/notify').then(({ refreshAdminCards }) => refreshAdminCards(orderId)).catch(() => undefined);
}

/** Job offer buttons. "Can't now" asks once more (a wrong tap would give the job away). */
function offerKeyboard(offerId: string) {
  return new InlineKeyboard()
    .text('✅ Coming · 15 min', `jo:${offerId}:15`)
    .text('✅ Coming · 30 min', `jo:${offerId}:30`)
    .row()
    .text('❌ Can’t now', `jo:${offerId}:ask`);
}

/** Driver tapped "Can't now" by mistake: take it back while nobody else has the job. */
export async function retakeOffer(offerId: string, telegramId: number) {
  const offer = await prisma.deliveryOffer.findUnique({ where: { id: offerId }, include: { driver: true, order: true } });
  if (!offer || offer.driver.telegramId?.toString() !== String(telegramId)) return { text: 'This job isn’t yours', ok: false };
  if (offer.status !== 'declined') return { text: 'Already answered', ok: false };
  const o = offer.order;
  if (o.cancelAt || ['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(o.status)) return { text: 'This order isn’t open any more', ok: false };
  const other = await prisma.deliveryOffer.findFirst({ where: { orderId: o.id, status: { in: ['offered', 'accepted'] } }, include: { driver: true } });
  if (other) return { text: `Sorry — it already went to another driver`, ok: false };
  const claimed = await prisma.deliveryOffer.updateMany({
    where: { id: offerId, status: 'declined' },
    data: { status: 'offered', respondedAt: null, expiresAt: new Date(Date.now() + OFFER_MINUTES * 60_000) },
  });
  if (!claimed.count) return { text: 'Already answered', ok: false };
  await tellStaff(`↩️ <b>${escapeHtml(offer.driver.name)}</b> changed their mind about <b>${escapeHtml(o.orderNumber)}</b> — answering again.`);
  refreshCards(o.id);
  return { text: 'OK — choose when you can come', ok: true };
}

/** Driver accepted by mistake / something came up: give the job back before the handover. */
export async function dropAccepted(offerId: string, telegramId: number) {
  const offer = await prisma.deliveryOffer.findUnique({ where: { id: offerId }, include: { driver: true, order: true } });
  if (!offer || offer.driver.telegramId?.toString() !== String(telegramId)) return 'This job isn’t yours';
  if (offer.status !== 'accepted') return offer.status === 'completed' ? 'You already have the items — use “Couldn’t deliver” on the delivery card' : 'Already answered';
  const claimed = await prisma.deliveryOffer.updateMany({ where: { id: offerId, status: 'accepted' }, data: { status: 'declined', respondedAt: new Date() } });
  if (!claimed.count) return 'Already answered';
  await prisma.order.updateMany({ where: { id: offer.orderId, driverId: offer.driverId }, data: { driverId: null } });
  await tellStaff(`❌ <b>${escapeHtml(offer.driver.name)}</b> can’t come for <b>${escapeHtml(offer.order.orderNumber)}</b> after all.`, pickAgain(offer.orderId));
  refreshCards(offer.orderId);
  return 'OK — the shop has been told. Thanks for letting us know.';
}

/** Sends a job offer to one driver. */
async function offerTo(orderId: string, driverId: string, auto: boolean) {
  const [order, driver, shop, settings] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } }),
    prisma.driver.findUniqueOrThrow({ where: { id: driverId } }),
    shopPoint(),
    prisma.settings.findUniqueOrThrow({ where: { id: 'default' } }),
  ]);
  const offer = await prisma.deliveryOffer.create({ data: { orderId, driverId, auto, expiresAt: new Date(Date.now() + OFFER_MINUTES * 60_000) } });
  if (bot && driver.telegramId) {
    const toCollect = Math.max(0, order.total - order.amountPaid);
    const away = shop && driver.lat != null && driver.lng != null ? ` · you’re ${(Math.round(km(shop, { lat: driver.lat, lng: driver.lng }) * 10) / 10).toString()} km from the shop` : '';
    const text = [
      `🛵 <b>New delivery job · ${escapeHtml(order.orderNumber)}</b>`,
      '',
      `🏪 Pick up: ${escapeHtml(settings.addressEn)}${away}`,
      `📍 Deliver to: ${escapeHtml([order.area, order.landmark, order.city].filter(Boolean).join(', ') || order.deliveryLabel)}`,
      `📦 ${order.items.reduce((n, i) => n + i.quantity, 0)} item(s)`,
      toCollect > 0 ? `💵 Collect ${birr(toCollect)}` : '✅ Already paid',
      '',
      `Answer within ${OFFER_MINUTES} minutes — otherwise it goes to another driver.`,
    ].join('\n');
    const kb = offerKeyboard(offer.id);
    try {
      const msg = await driverSend(driver, text, { parse_mode: 'HTML', reply_markup: kb });
      if (msg) await prisma.deliveryOffer.update({ where: { id: offer.id }, data: { messageId: msg.message_id } });
    } catch (err) {
      logger.warn({ err: (err as Error).message, driverId }, 'job offer not delivered');
    }
  }
  refreshCards(orderId);
  return offer;
}

/** Staff: find the nearest driver (driverId omitted) or offer to a chosen driver. */
export async function dispatch(orderId: string, driverId: string | null, actor: { id: string | null; fullName: string }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order not found');
  assertDispatchable(order);
  const active = await prisma.deliveryOffer.findFirst({ where: { orderId, status: { in: ['offered', 'accepted'] } } });
  if (active) throw conflict('This order already has a driver offer — cancel it first', 'ALREADY');
  let target: string;
  if (driverId) {
    const d = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!d?.isActive) throw notFound('Driver not found');
    if (!d.telegramId) throw conflict(`${d.name} hasn’t connected Telegram yet`, 'NOT_LINKED');
    target = d.id;
  } else {
    const tried = await prisma.deliveryOffer.findMany({ where: { orderId, status: { in: ['declined', 'expired'] } }, select: { driverId: true } });
    const best = await pickDriver(new Set(tried.map((t) => t.driverId)));
    if (!best) throw conflict('No driver is free right now — ask a driver to tap 🟢 Online in the bot, or pick one', 'NO_DRIVER');
    target = best.driver.id;
  }
  const offer = await offerTo(orderId, target, !driverId);
  void logActivity({ actorId: actor.id, actorName: actor.fullName, action: 'order.dispatch', summary: `Offered ${order.orderNumber} to a driver${driverId ? '' : ' (nearest)'}`, entity: 'order', entityId: orderId });
  return offer;
}

export async function cancelDispatch(orderId: string) {
  const active = await prisma.deliveryOffer.findMany({ where: { orderId, status: { in: ['offered', 'accepted'] } }, include: { driver: true, order: true } });
  for (const o of active) {
    await prisma.deliveryOffer.update({ where: { id: o.id }, data: { status: 'cancelled', respondedAt: new Date() } });
    await driverSend(o.driver, `↩️ ${o.order.orderNumber} was cancelled by the shop — no need to come.`);
  }
  await prisma.order.update({ where: { id: orderId }, data: { driverId: null } });
  refreshCards(orderId);
}

/** Staff: the driver took the items → order is on the way (customer gets the code, driver the delivery card). */
export async function handover(orderId: string, actorId: string | null) {
  const offer = await prisma.deliveryOffer.findFirst({ where: { orderId, status: 'accepted' }, include: { driver: true } });
  if (!offer) throw conflict('No driver has accepted this order yet', 'NOT_ACCEPTED');
  const { changeStatus } = await import('../orders/orders.service');
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status === 'CONFIRMED') await changeStatus(orderId, 'PACKING', actorId); // one step at a time
  if (order.status !== 'OUT_FOR_DELIVERY') await changeStatus(orderId, 'OUT_FOR_DELIVERY', actorId, `Handed to ${offer.driver.name}`, { trusted: true });
  await prisma.deliveryOffer.update({ where: { id: offer.id }, data: { status: 'completed', handedAt: new Date() } });
  const { sendDriverCard } = await import('./drivers');
  await sendDriverCard(orderId).catch((err) => logger.warn({ err }, 'delivery card failed'));
  refreshCards(orderId);
}

/** Current dispatch state of an order, for the admin order page. */
export async function dispatchState(orderId: string) {
  const [offer, order, shop] = await Promise.all([
    prisma.deliveryOffer.findFirst({ where: { orderId }, orderBy: { offeredAt: 'desc' }, include: { driver: true } }),
    prisma.order.findUnique({ where: { id: orderId }, include: { driver: true } }),
    shopPoint(),
  ]);
  const d = order?.driver ?? offer?.driver ?? null;
  return {
    offer: offer
      ? { id: offer.id, status: offer.status, auto: offer.auto, etaMinutes: offer.etaMinutes, expiresAt: offer.expiresAt, respondedAt: offer.respondedAt, driverName: offer.driver.name, driverPhone: offer.driver.phone }
      : null,
    tried: await prisma.deliveryOffer.count({ where: { orderId, status: { in: ['declined', 'expired'] } } }),
    driver: d
      ? {
          id: d.id,
          name: d.name,
          phone: d.phone,
          locationAt: d.locationAt,
          live: locationFresh(d),
          mapUrl: d.lat != null && d.lng != null ? `https://maps.google.com/?q=${d.lat},${d.lng}` : null,
          distanceKm: shop && d.lat != null && d.lng != null ? Math.round(km(shop, { lat: d.lat, lng: d.lng }) * 10) / 10 : null,
        }
      : null,
  };
}

/** A driver answered an offer (from the bot). */
export async function respond(offerId: string, telegramId: number, answer: 'no' | number) {
  const offer = await prisma.deliveryOffer.findUnique({ where: { id: offerId }, include: { driver: true, order: true } });
  if (!offer || offer.driver.telegramId?.toString() !== String(telegramId)) return { text: 'This job isn’t yours' };
  if (offer.status !== 'offered') return { text: offer.status === 'expired' ? '⌛ Too late — it went to another driver' : 'Already answered' };
  if (offer.expiresAt < new Date()) {
    await expire(offer.id);
    return { text: '⌛ Too late — it went to another driver' };
  }
  if (answer === 'no') {
    await prisma.deliveryOffer.update({ where: { id: offer.id }, data: { status: 'declined', respondedAt: new Date() } });
    await tellStaff(`❌ <b>${escapeHtml(offer.driver.name)}</b> can’t take <b>${escapeHtml(offer.order.orderNumber)}</b>.${offer.auto ? ' Trying the next driver…' : ''}`, offer.auto ? undefined : pickAgain(offer.orderId));
    if (offer.auto) await next(offer.orderId);
    refreshCards(offer.orderId);
    return { text: 'OK, thanks — we’ll ask someone else.', done: 'declined' as const };
  }
  const claimed = await prisma.deliveryOffer.updateMany({ where: { id: offer.id, status: 'offered' }, data: { status: 'accepted', etaMinutes: answer, respondedAt: new Date() } });
  if (!claimed.count) return { text: 'Already answered' };
  await prisma.order.update({ where: { id: offer.orderId }, data: { driverId: offer.driverId } });
  await prisma.orderEvent.create({ data: { orderId: offer.orderId, type: 'internal_driver_accepted', message: `${offer.driver.name} accepted — at the shop in ~${answer} min` } });
  await tellStaff(`🛵 <b>${escapeHtml(offer.driver.name)}</b> accepted <b>${escapeHtml(offer.order.orderNumber)}</b> — at the shop in ~${answer} min. Tap “Handed over” on the order card when they take it.`);
  refreshCards(offer.orderId);
  void logActivity({ actorName: offer.driver.name, action: 'driver.accept', summary: `${offer.driver.name} accepted ${offer.order.orderNumber} (~${answer} min)`, entity: 'order', entityId: offer.orderId });
  return { text: `✅ Thanks! Come to the shop in ~${answer} min. The shop gives you the items and the delivery details.`, done: 'accepted' as const };
}

async function next(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || ['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(order.status)) return;
  const tried = await prisma.deliveryOffer.findMany({ where: { orderId }, select: { driverId: true } });
  if (tried.length >= MAX_AUTO_TRIES) {
    await tellStaff(`⚠️ No driver took <b>${escapeHtml(order.orderNumber)}</b> after ${tried.length} tries — please pick one.`, pickAgain(orderId));
    return;
  }
  const best = await pickDriver(new Set(tried.map((t) => t.driverId)));
  if (!best) {
    await tellStaff(`⚠️ No other driver is free for <b>${escapeHtml(order.orderNumber)}</b> — please pick one.`, pickAgain(orderId));
    return;
  }
  await offerTo(orderId, best.driver.id, true);
}

async function expire(offerId: string) {
  const claimed = await prisma.deliveryOffer.updateMany({ where: { id: offerId, status: 'offered' }, data: { status: 'expired', respondedAt: new Date() } });
  if (!claimed.count) return;
  const o = await prisma.deliveryOffer.findUniqueOrThrow({ where: { id: offerId }, include: { driver: true, order: true } });
  if (bot && o.driver.telegramId && o.messageId) {
    await bot.api.editMessageReplyMarkup(Number(o.driver.telegramId), o.messageId, { reply_markup: undefined }).catch(() => undefined);
  }
  await tellStaff(`⌛ <b>${escapeHtml(o.driver.name)}</b> didn’t answer for <b>${escapeHtml(o.order.orderNumber)}</b>.${o.auto ? ' Trying the next driver…' : ''}`, o.auto ? undefined : pickAgain(o.orderId));
  if (o.auto) await next(o.orderId);
  refreshCards(o.orderId);
}

/** Minutes after the handover before the shop hears "taking longer than expected". */
const LATE_MINUTES = 60;

async function checkLate() {
  const late = await prisma.deliveryOffer.findMany({
    where: { status: 'completed', lateAlertAt: null, handedAt: { lt: new Date(Date.now() - LATE_MINUTES * 60_000) }, order: { status: 'OUT_FOR_DELIVERY' } },
    include: { driver: true, order: true },
    take: 10,
  });
  for (const o of late) {
    const claimed = await prisma.deliveryOffer.updateMany({ where: { id: o.id, lateAlertAt: null }, data: { lateAlertAt: new Date() } });
    if (!claimed.count) continue;
    await tellStaff(
      `⏰ <b>${escapeHtml(o.order.orderNumber)}</b> is taking longer than expected — out with <b>${escapeHtml(o.driver.name)}</b> for over ${LATE_MINUTES} min and not confirmed yet.` +
        (o.driver.phone ? `
📞 <a href="tel:${o.driver.phone}">${o.driver.phone}</a>` : ''),
      new InlineKeyboard().text(`📨 Ask ${o.driver.name.split(' ')[0]} what happened`, `lt:${o.orderId}`),
    );
  }
}

/** Shop → driver: "what happened?" with one-tap answers (answers come back to the shop chat). */
export async function askDriver(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { driver: true } });
  if (!order?.driver || order.status !== 'OUT_FOR_DELIVERY') throw conflict('This order isn’t out with a driver', 'NOT_OUT');
  const kb = new InlineKeyboard()
    .text('✅ Delivered — enter code', `dv:${orderId}:done`)
    .row()
    .text('🛵 On my way', `dr:${orderId}:way`)
    .text('📵 Customer not answering', `dr:${orderId}:noanswer`)
    .row()
    .text('⚠️ Can’t deliver', `dv:${orderId}:askfail`);
  await driverSend(order.driver, `❓ The shop is asking about <b>${escapeHtml(order.orderNumber)}</b> — what’s happening?`, { parse_mode: 'HTML', reply_markup: kb });
  return order.driver.name;
}

/** Closes offers left open on orders that already finished (e.g. cancelled before drivers were told). */
async function closeOrphanOffers() {
  await prisma.deliveryOffer.updateMany({
    where: { status: { in: ['offered', 'accepted'] }, order: { status: { in: ['DELIVERED', 'PICKED_UP', 'CANCELLED', 'OUT_FOR_DELIVERY'] } } },
    data: { status: 'cancelled', respondedAt: new Date() },
  });
}

/** Expires unanswered offers (and moves on). */
export function startDispatchWorker() {
  const timer = setInterval(async () => {
    try {
      const due = await prisma.deliveryOffer.findMany({ where: { status: 'offered', expiresAt: { lt: new Date() } }, select: { id: true }, take: 20 });
      for (const d of due) await expire(d.id);
      await checkLate();
      await closeOrphanOffers();
      // Staff cancels whose undo window ran out
      await (await import('../orders/orders.service')).commitDueCancels();
    } catch (err) {
      logger.warn({ err }, 'dispatch worker failed');
    }
  }, 15_000);
  return () => clearInterval(timer);
}

// ─── Bot: offers, online/offline, location (driver buttons) ──

/** 🟢 Online / ⚪ Offline — from the driver's buttons (or the old /online, /offline commands). */
async function setOnline(telegramId: number, online: boolean) {
  const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!d) return null;
  await prisma.driver.update({ where: { id: d.id }, data: { isOnline: online } });
  return d;
}

if (bot) {
  bot.callbackQuery(/^lt:([a-z0-9]+)$/, async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    if (!settings?.adminChatId || String(ctx.chat?.id) !== settings.adminChatId) return void (await ctx.answerCallbackQuery({ text: 'Not allowed here' }));
    try {
      const name = await askDriver(ctx.match[1]!);
      await ctx.answerCallbackQuery({ text: `📨 Asked ${name} — the answer comes here` });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190), show_alert: true });
    }
  });

  bot.callbackQuery(/^dr:([a-z0-9]+):(way|noanswer)$/, async (ctx) => {
    const [, orderId, a] = ctx.match;
    const driver = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!driver || !order || order.driverId !== driver.id) return void (await ctx.answerCallbackQuery({ text: 'This order isn’t assigned to you', show_alert: true }));
    await ctx.answerCallbackQuery({ text: '✅ Sent to the shop' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await tellStaff(
      a === 'way'
        ? `🛵 <b>${escapeHtml(driver.name)}</b>: on the way with <b>${escapeHtml(order.orderNumber)}</b>.`
        : `📵 <b>${escapeHtml(driver.name)}</b>: the customer of <b>${escapeHtml(order.orderNumber)}</b> isn’t answering. Call them: <a href="tel:${order.customerPhone}">${order.customerPhone}</a>`,
      new InlineKeyboard().text('📨 Ask again', `lt:${orderId}`),
    );
    if (a === 'way') await prisma.deliveryOffer.updateMany({ where: { orderId: order.id, status: 'completed' }, data: { lateAlertAt: null, handedAt: new Date() } }); // remind again later
  });

  bot.callbackQuery(/^jo:([a-z0-9]+):(ask|back|again|askdrop|drop|keep)$/, async (ctx) => {
    const [, offerId, a] = ctx.match;
    const sure = (yes: string, yesData: string, backData: string) =>
      ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(yes, `jo:${offerId}:${yesData}`).row().text('↩️ No, go back', `jo:${offerId}:${backData}`) }).catch(() => undefined);
    if (a === 'ask') {
      await ctx.answerCallbackQuery({ text: 'Sure? The job goes to another driver.' });
      return void (await sure('❌ Yes, I can’t take it', 'no', 'back'));
    }
    if (a === 'back') {
      await ctx.answerCallbackQuery();
      return void (await ctx.editMessageReplyMarkup({ reply_markup: offerKeyboard(offerId!) }).catch(() => undefined));
    }
    if (a === 'askdrop') {
      await ctx.answerCallbackQuery({ text: 'Sure? The shop will find someone else.' });
      return void (await sure('❌ Yes, I can’t come', 'drop', 'keep'));
    }
    if (a === 'keep') {
      await ctx.answerCallbackQuery({ text: '👍 Great — see you at the shop' });
      return void (await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('❌ I can’t come after all', `jo:${offerId}:askdrop`) }).catch(() => undefined));
    }
    if (a === 'drop') {
      const text = await dropAccepted(offerId!, ctx.from.id);
      await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return;
    }
    // again: "I can come after all" after declining (only while nobody else has the job)
    const r = await retakeOffer(offerId!, ctx.from.id);
    await ctx.answerCallbackQuery({ text: r.text.slice(0, 190), show_alert: !r.ok });
    await ctx.editMessageReplyMarkup({ reply_markup: r.ok ? offerKeyboard(offerId!) : undefined }).catch(() => undefined);
  });

  bot.callbackQuery(/^jo:([a-z0-9]+):(no|\d{1,3})$/, async (ctx) => {
    const [, offerId, a] = ctx.match;
    const r = await respond(offerId!, ctx.from.id, a === 'no' ? 'no' : Number(a));
    await ctx.answerCallbackQuery({ text: r.text.slice(0, 190) });
    if (r.done) {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
      if (d) {
        // After declining: a way back while nobody else has it. After accepting: a way out before the handover.
        await driverSend(d, r.text, {
          reply_markup:
            r.done === 'declined'
              ? new InlineKeyboard().text('↩️ I can come after all', `jo:${offerId}:again`)
              : new InlineKeyboard().text('❌ I can’t come after all', `jo:${offerId}:askdrop`),
        });
        if (r.done === 'accepted') {
          const s = await shopPoint();
          if (s) await driverSendLocation(d, s.lat, s.lng);
        }
      }
    }
  });

  const goOnline = async (telegramId: number) => {
    const d = await setOnline(telegramId, true);
    if (!d) return;
    const fresh = locationFresh(d);
    await driverSend(
      d,
      fresh
        ? `🟢 You’re online, ${d.name}. New jobs near you will arrive here.`
        : `🟢 You’re online, ${escapeHtml(d.name)}.\n\n${LIVE_HOWTO}`,
      { parse_mode: 'HTML', reply_markup: driverKeyboard() },
    );
  };
  const goOffline = async (telegramId: number) => {
    const d = await setOnline(telegramId, false);
    if (d) await driverSend(d, `⚪ You’re offline — no new jobs until you tap “${BTN_ONLINE}”.`, { reply_markup: driverKeyboard() });
  };

  bot.hears(BTN_ONLINE, (ctx) => (ctx.chat.type === 'private' && ctx.from ? goOnline(ctx.from.id) : undefined));
  bot.hears(BTN_LIVE, async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) return;
    const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (d) await driverSend(d, LIVE_HOWTO, { parse_mode: 'HTML', reply_markup: driverKeyboard() });
  });
  bot.hears(BTN_OFFLINE, (ctx) => (ctx.chat.type === 'private' && ctx.from ? goOffline(ctx.from.id) : undefined));
  bot.command('online', (ctx) => (ctx.chat.type === 'private' && ctx.from ? goOnline(ctx.from.id) : undefined));
  bot.command('offline', (ctx) => (ctx.chat.type === 'private' && ctx.from ? goOffline(ctx.from.id) : undefined));

  // Location: the 📍 button (one location) or a live location (Telegram sends edits as the driver moves)
  const saveLocation = async (telegramId: number, lat: number, lng: number) => {
    await prisma.driver.updateMany({ where: { telegramId: BigInt(telegramId) }, data: { lat, lng, locationAt: new Date() } });
  };
  bot.on('message:location', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!d) return next();
    // Only LIVE location counts — a one-time pin is stale as soon as the driver moves
    if (!ctx.message.location.live_period) {
      await driverSend(d, `⚠️ That’s a one-time pin — the shop needs your <b>live</b> location.\n\n${LIVE_HOWTO}`, { parse_mode: 'HTML', reply_markup: driverKeyboard() });
      return;
    }
    await saveLocation(ctx.from.id, ctx.message.location.latitude, ctx.message.location.longitude);
    if (!d.isOnline) await prisma.driver.update({ where: { id: d.id }, data: { isOnline: true } });
    await driverSend(d, '📡 Live location on — you’re online and the shop sees you. Tap ⚪ Offline when you stop.', { reply_markup: driverKeyboard() });
  });
  bot.on('edited_message:location', async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) return;
    await saveLocation(ctx.from.id, ctx.editedMessage.location.latitude, ctx.editedMessage.location.longitude);
  });
}

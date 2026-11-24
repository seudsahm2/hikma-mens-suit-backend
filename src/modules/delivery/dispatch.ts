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
async function busyDriverIds() {
  const [offers, onTheWay] = await Promise.all([
    prisma.deliveryOffer.findMany({ where: { status: { in: ['offered', 'accepted'] } }, select: { driverId: true } }),
    prisma.order.findMany({ where: { status: 'OUT_FOR_DELIVERY', driverId: { not: null } }, select: { driverId: true } }),
  ]);
  return new Set([...offers.map((o) => o.driverId), ...onTheWay.map((o) => o.driverId!)]);
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
      fresh,
      distanceKm: shop && d.lat != null && d.lng != null ? Math.round(km(shop, { lat: d.lat, lng: d.lng }) * 10) / 10 : null,
    };
  });
}

/** Best available driver for an order: online, linked, not busy, nearest to the shop (fresh location first). */
async function pickDriver(exclude: Set<string>) {
  const board = await driverBoard();
  const candidates = board.filter((b) => b.driver.isActive && b.driver.telegramId && b.driver.isOnline && !b.busy && !exclude.has(b.driver.id));
  candidates.sort((a, b) => {
    if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
    if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;
    return (b.driver.locationAt?.getTime() ?? 0) - (a.driver.locationAt?.getTime() ?? 0);
  });
  return candidates[0] ?? null;
}

async function tellStaff(text: string) {
  if (!bot) return;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (s?.adminChatId) await bot.api.sendMessage(s.adminChatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
}

function assertDispatchable(o: { status: string; deliveryOptionId: string }) {
  if (o.deliveryOptionId === 'pickup') throw conflict('This order is picked up at the shop', 'PICKUP');
  if (['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(o.status)) throw conflict('This order is already on the way or finished', 'FINISHED');
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
    const kb = new InlineKeyboard()
      .text('✅ Coming · 15 min', `jo:${offer.id}:15`)
      .text('✅ Coming · 30 min', `jo:${offer.id}:30`)
      .row()
      .text('❌ Can’t now', `jo:${offer.id}:no`);
    try {
      const msg = await bot.api.sendMessage(Number(driver.telegramId), text, { parse_mode: 'HTML', reply_markup: kb });
      await prisma.deliveryOffer.update({ where: { id: offer.id }, data: { messageId: msg.message_id } });
    } catch (err) {
      logger.warn({ err: (err as Error).message, driverId }, 'job offer not delivered');
    }
  }
  return offer;
}

/** Staff: find the nearest driver (driverId omitted) or offer to a chosen driver. */
export async function dispatch(orderId: string, driverId: string | null, actor: { id: string; fullName: string }) {
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
    if (!best) throw conflict('No driver is free right now — ask a driver to send /online, or pick one', 'NO_DRIVER');
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
    if (bot && o.driver.telegramId) await bot.api.sendMessage(Number(o.driver.telegramId), `↩️ ${o.order.orderNumber} was cancelled by the shop — no need to come.`).catch(() => undefined);
  }
  await prisma.order.update({ where: { id: orderId }, data: { driverId: null } });
}

/** Staff: the driver took the items → order is on the way (customer gets the code, driver the delivery card). */
export async function handover(orderId: string, actorId: string) {
  const offer = await prisma.deliveryOffer.findFirst({ where: { orderId, status: 'accepted' }, include: { driver: true } });
  if (!offer) throw conflict('No driver has accepted this order yet', 'NOT_ACCEPTED');
  const { changeStatus } = await import('../orders/orders.service');
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== 'OUT_FOR_DELIVERY') await changeStatus(orderId, 'OUT_FOR_DELIVERY', actorId, `Handed to ${offer.driver.name}`);
  await prisma.deliveryOffer.update({ where: { id: offer.id }, data: { status: 'completed' } });
  const { sendDriverCard } = await import('./drivers');
  await sendDriverCard(orderId).catch((err) => logger.warn({ err }, 'delivery card failed'));
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
    await tellStaff(`❌ <b>${escapeHtml(offer.driver.name)}</b> can’t take <b>${escapeHtml(offer.order.orderNumber)}</b>.${offer.auto ? ' Trying the next driver…' : ''}`);
    if (offer.auto) await next(offer.orderId);
    return { text: 'OK, thanks — we’ll ask someone else.', done: 'declined' as const };
  }
  const claimed = await prisma.deliveryOffer.updateMany({ where: { id: offer.id, status: 'offered' }, data: { status: 'accepted', etaMinutes: answer, respondedAt: new Date() } });
  if (!claimed.count) return { text: 'Already answered' };
  await prisma.order.update({ where: { id: offer.orderId }, data: { driverId: offer.driverId } });
  await prisma.orderEvent.create({ data: { orderId: offer.orderId, type: 'internal_driver_accepted', message: `${offer.driver.name} accepted — at the shop in ~${answer} min` } });
  await tellStaff(`🛵 <b>${escapeHtml(offer.driver.name)}</b> accepted <b>${escapeHtml(offer.order.orderNumber)}</b> — at the shop in ~${answer} min. Tap “Handed over” in the admin when they take it.`);
  void logActivity({ actorName: offer.driver.name, action: 'driver.accept', summary: `${offer.driver.name} accepted ${offer.order.orderNumber} (~${answer} min)`, entity: 'order', entityId: offer.orderId });
  return { text: `✅ Thanks! Come to the shop in ~${answer} min. The shop gives you the items and the delivery details.`, done: 'accepted' as const };
}

async function next(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || ['OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(order.status)) return;
  const tried = await prisma.deliveryOffer.findMany({ where: { orderId }, select: { driverId: true } });
  if (tried.length >= MAX_AUTO_TRIES) {
    await tellStaff(`⚠️ No driver took <b>${escapeHtml(order.orderNumber)}</b> after ${tried.length} tries — please pick one in the admin.`);
    return;
  }
  const best = await pickDriver(new Set(tried.map((t) => t.driverId)));
  if (!best) {
    await tellStaff(`⚠️ No other driver is free for <b>${escapeHtml(order.orderNumber)}</b> — please pick one in the admin.`);
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
  await tellStaff(`⌛ <b>${escapeHtml(o.driver.name)}</b> didn’t answer for <b>${escapeHtml(o.order.orderNumber)}</b>.${o.auto ? ' Trying the next driver…' : ' Pick another driver in the admin.'}`);
  if (o.auto) await next(o.orderId);
}

/** Expires unanswered offers (and moves on). */
export function startDispatchWorker() {
  const timer = setInterval(async () => {
    try {
      const due = await prisma.deliveryOffer.findMany({ where: { status: 'offered', expiresAt: { lt: new Date() } }, select: { id: true }, take: 20 });
      for (const d of due) await expire(d.id);
    } catch (err) {
      logger.warn({ err }, 'dispatch worker failed');
    }
  }, 30_000);
  return () => clearInterval(timer);
}

// ─── Bot: offers, online/offline, live location ──────────

if (bot) {
  bot.callbackQuery(/^jo:([a-z0-9]+):(no|\d{1,3})$/, async (ctx) => {
    const [, offerId, a] = ctx.match;
    const r = await respond(offerId!, ctx.from.id, a === 'no' ? 'no' : Number(a));
    await ctx.answerCallbackQuery({ text: r.text.slice(0, 190) });
    if (r.done) {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.reply(r.text);
      if (r.done === 'accepted') {
        const s = await shopPoint();
        if (s) await ctx.replyWithLocation(s.lat, s.lng).catch(() => undefined);
      }
    }
  });

  const setOnline = async (telegramId: number, online: boolean) => {
    const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!d) return null;
    await prisma.driver.update({ where: { id: d.id }, data: { isOnline: online } });
    return d;
  };
  bot.command('online', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const d = await setOnline(ctx.from!.id, true);
    if (!d) return void (await ctx.reply('Only connected delivery people can go online.'));
    await ctx.reply(
      `🟢 You’re online, ${d.name}. Jobs near you will arrive here.\n\n📍 Please share your LIVE location so the shop gives you the nearest jobs:\nAttach (📎) → Location → “Share My Live Location” (8 hours).\n\nSend /offline when you stop.`,
    );
  });
  bot.command('offline', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const d = await setOnline(ctx.from!.id, false);
    if (d) await ctx.reply('⚪ You’re offline — no new jobs until you send /online.');
  });

  // Location updates (a single location, or a live location — Telegram sends edits as it moves)
  const saveLocation = async (telegramId: number, lat: number, lng: number) => {
    await prisma.driver.updateMany({ where: { telegramId: BigInt(telegramId) }, data: { lat, lng, locationAt: new Date() } });
  };
  bot.on('message:location', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const d = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!d) return next();
    await saveLocation(ctx.from.id, ctx.message.location.latitude, ctx.message.location.longitude);
    if (!d.isOnline) await prisma.driver.update({ where: { id: d.id }, data: { isOnline: true } });
    await ctx.reply(ctx.message.location.live_period ? '📍 Thanks — the shop can now see you’re nearby. You’re online.' : '📍 Got it. Tip: “Share My Live Location” keeps it updated automatically.');
  });
  bot.on('edited_message:location', async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) return;
    await saveLocation(ctx.from.id, ctx.editedMessage.location.latitude, ctx.editedMessage.location.longitude);
  });
}

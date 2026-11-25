/**
 * Delivery people. The owner adds a driver (name + phone) and gives them a one-time code; the
 * driver sends "/driver CODE" to the bot once. Then:
 *   - staff assign an order → the driver gets a card: customer, phone, address, map, cash to collect
 *   - at the door the driver taps ✅ Delivered and types the customer's 4-digit delivery code
 *     (the customer got it on Telegram / sees it on their order page). Right code = delivered.
 *   - the customer can also confirm themselves ("✅ I received it")
 * Staff never see the code, so an order can't be marked delivered without the customer.
 */
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { InlineKeyboard, type Context } from 'grammy';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { requireStaff } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { bot } from '../telegram/bot';
import { birr, escapeHtml } from '../telegram/media';
import { logActivity } from '../admin/activity';
import { cancelDispatch, dispatch, dispatchState, driverBoard, handover } from './dispatch';
import { BTN_OFFLINE, LIVE_HOWTO, BTN_ONLINE, DRIVER_BUTTONS, driverKeyboard, driverSend, ensureDriverTopic } from './driverChat';

const MAX_TRIES = 5;
const linkCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');

async function alertStaff(text: string) {
  if (!bot) return;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (s?.adminChatId) await bot.api.sendMessage(s.adminChatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
}

function mapLink(o: { lat: number | null; lng: number | null; area: string | null; landmark: string | null; city: string | null }) {
  if (o.lat !== null && o.lng !== null) return `https://maps.google.com/?q=${o.lat},${o.lng}`;
  const q = [o.landmark, o.area, o.city ?? 'Addis Ababa'].filter(Boolean).join(', ');
  return q ? `https://maps.google.com/?q=${encodeURIComponent(q)}` : null;
}

/** The order card a driver receives. */
export async function sendDriverCard(orderId: string) {
  if (!bot) return;
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, driver: true } });
  if (!o?.driver?.telegramId) return;
  const toCollect = Math.max(0, o.total - o.amountPaid);
  const map = mapLink(o);
  const text = [
    `🚚 <b>Delivery · ${escapeHtml(o.orderNumber)}</b>`,
    '',
    `👤 ${escapeHtml(o.customerName)} · <a href="tel:${o.customerPhone}">${o.customerPhone}</a>`,
    `📍 ${escapeHtml([o.area, o.landmark, o.city].filter(Boolean).join(', ') || o.deliveryLabel)}`,
    `📦 ${o.items.reduce((n, i) => n + i.quantity, 0)} item(s): ${escapeHtml(o.items.map((i) => `${i.productName}${i.size ? ` ${i.size}` : ''}`).join(', ').slice(0, 300))}`,
    toCollect > 0 ? `💵 <b>Collect ${birr(toCollect)}</b>${o.paymentLabel ? ` (${escapeHtml(o.paymentLabel)})` : ''}` : '✅ Already paid — collect nothing',
    o.note ? `📝 ${escapeHtml(o.note)}` : '',
    '',
    'At the door: tap ✅ Delivered and type the 4-digit code the customer gives you.',
  ]
    .filter(Boolean)
    .join('\n');
  const kb = deliveryKeyboard(o.id, map);
  await driverSend(o.driver, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
}

/** Delivery card buttons. "Couldn't deliver" asks once more (it alarms the shop). */
function deliveryKeyboard(orderId: string, map: string | null) {
  const kb = new InlineKeyboard().text('✅  Delivered', `dv:${orderId}:done`).text('⚠️  Couldn’t deliver', `dv:${orderId}:askfail`);
  if (map) kb.row().url('🗺  Open map', map);
  return kb;
}

async function markDelivered(orderId: string, note: string) {
  const { changeStatus } = await import('../orders/orders.service');
  const { refreshAdminCards } = await import('../telegram/notify');
  await changeStatus(orderId, 'DELIVERED', null, note, { trusted: true }); // driver typed the code / customer confirmed
  await refreshAdminCards(orderId).catch(() => undefined);
  // The shop hears about every confirmed delivery (note says who and how much was collected)
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
  if (o) await alertStaff(`✅ <b>${escapeHtml(o.orderNumber)}</b> delivered — ${escapeHtml(note)}.`);
}

// ─── Cash with drivers ───────────────────────────────────

/** Cash each driver collected on delivery and hasn't handed to the shop yet. */
export async function cashByDriver() {
  const rows = await prisma.order.findMany({
    where: { cashCollected: { gt: 0 }, cashSettledAt: null, cashDriverId: { not: null } },
    select: { id: true, orderNumber: true, cashCollected: true, cashDriverId: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  const map = new Map<string, { amount: number; orders: { orderNumber: string; amount: number; at: Date }[] }>();
  for (const r of rows) {
    const e = map.get(r.cashDriverId!) ?? { amount: 0, orders: [] };
    e.amount += r.cashCollected;
    e.orders.push({ orderNumber: r.orderNumber, amount: r.cashCollected, at: r.updatedAt });
    map.set(r.cashDriverId!, e);
  }
  return map;
}

// ─── Admin ───────────────────────────────────────────────

export const driversRouter = Router();
driversRouter.use(requireStaff);

driversRouter.get(
  '/drivers',
  ah(async (_req, res) => {
    const [board, cash] = await Promise.all([driverBoard(), cashByDriver()]);
    res.json({
      drivers: board.map(({ driver: d, busy, fresh, distanceKm }) => ({
        id: d.id,
        name: d.name,
        phone: d.phone,
        isActive: d.isActive,
        linked: Boolean(d.telegramId),
        linkCode: d.telegramId ? null : d.linkCode,
        isOnline: d.isOnline,
        busy,
        live: fresh,
        distanceKm,
        locationAt: d.locationAt,
        mapUrl: d.lat != null && d.lng != null ? `https://maps.google.com/?q=${d.lat},${d.lng}` : null,
        cash: cash.get(d.id) ?? { amount: 0, orders: [] },
      })),
    });
  }),
);

driversRouter.post(
  '/drivers',
  validate(z.object({ name: z.string().trim().min(2).max(60), phone: z.string().trim().min(9).max(20) })),
  ah(async (req, res) => {
    const phone = normalizeEthiopianPhone(req.body.phone);
    if (!phone) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
    const d = await prisma.driver.create({ data: { name: req.body.name, phone, linkCode: linkCode() } });
    res.status(201).json({ driver: { id: d.id, linkCode: d.linkCode } });
  }),
);

driversRouter.patch(
  '/drivers/:id',
  validate(z.object({ isActive: z.boolean().optional(), newCode: z.boolean().optional() })),
  ah(async (req, res) => {
    const d = await prisma.driver.update({
      where: { id: req.params.id },
      data: { ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {}), ...(req.body.newCode ? { linkCode: linkCode(), telegramId: null } : {}) },
    });
    res.json({ driver: { id: d.id, linkCode: d.telegramId ? null : d.linkCode } });
  }),
);

/** Where the delivery of an order stands (offer, driver, live location). */
driversRouter.get(
  '/orders/:id/dispatch',
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await dispatchState(req.params.id!));
  }),
);

/** Offer the job: to a chosen driver, or the nearest free one (driverId omitted). */
/** The driver handed the collected cash to the shop. */
driversRouter.post(
  '/drivers/:id/cash/received',
  ah(async (req, res) => {
    const d = await prisma.driver.findUnique({ where: { id: req.params.id! } });
    if (!d) throw notFound('Driver not found');
    const open = await prisma.order.findMany({ where: { cashDriverId: d.id, cashSettledAt: null, cashCollected: { gt: 0 } }, select: { id: true, cashCollected: true } });
    const amount = open.reduce((n, o) => n + o.cashCollected, 0);
    if (!open.length) return void res.json({ amount: 0 });
    await prisma.order.updateMany({ where: { id: { in: open.map((o) => o.id) } }, data: { cashSettledAt: new Date() } });
    void logActivity({ actorId: req.user!.id, actorName: req.user!.fullName, action: 'driver.cash', summary: `Received ${birr(amount)} cash from ${d.name} (${open.length} order${open.length === 1 ? '' : 's'})`, entity: 'driver', entityId: d.id });
    res.json({ amount, orders: open.length });
  }),
);

driversRouter.post(
  '/orders/:id/dispatch',
  validate(z.object({ driverId: z.string().min(1).max(40).optional() })),
  ah(async (req, res) => {
    await dispatch(req.params.id!, req.body.driverId ?? null, { id: req.user!.id, fullName: req.user!.fullName });
    res.status(201).json(await dispatchState(req.params.id!));
  }),
);

driversRouter.post(
  '/orders/:id/dispatch/cancel',
  ah(async (req, res) => {
    await cancelDispatch(req.params.id!);
    res.json(await dispatchState(req.params.id!));
  }),
);

/** The driver took the items: order goes "On the way" (customer gets the code). */
driversRouter.post(
  '/orders/:id/handover',
  ah(async (req, res) => {
    await handover(req.params.id!, req.user!.id);
    const { orderInclude, serializeOrder } = await import('../orders/orders.service');
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude });
    res.json({ order: serializeOrder(fresh, { staff: true }), dispatch: await dispatchState(req.params.id!) });
  }),
);

// ─── Delivery code check (the bot calls this; also unit-testable) ─

/** A driver typed a code in the bot chat. Returns what to answer, or null if it wasn't a code for us. */
export async function checkDeliveryCode(telegramUserId: number, text: string): Promise<{ text: string; again?: boolean } | null> {
  const driver = await prisma.driver.findUnique({ where: { telegramId: BigInt(telegramUserId) } });
  if (!driver?.awaitingOrderId) return null;
  const order = await prisma.order.findUnique({ where: { id: driver.awaitingOrderId } });
  if (!order || order.status !== 'OUT_FOR_DELIVERY' || order.driverId !== driver.id) {
    await prisma.driver.update({ where: { id: driver.id }, data: { awaitingOrderId: null } });
    return null;
  }
  if (order.deliveryCodeTries >= MAX_TRIES) return { text: 'Too many wrong codes — the shop will confirm this delivery.' };
  const typed = text.replace(/\D/g, '');
  if (order.deliveryCode && typed === order.deliveryCode) {
    await prisma.driver.update({ where: { id: driver.id }, data: { awaitingOrderId: null } });
    const collected = Math.max(0, order.total - order.amountPaid);
    await markDelivered(order.id, `Delivered by ${driver.name} · code confirmed${collected ? ` · collected ${birr(collected)}` : ''}`);
    void logActivity({ actorName: driver.name, action: 'order.delivered', summary: `${order.orderNumber} delivered (code confirmed)`, entity: 'order', entityId: order.id });
    return { text: `✅ ${order.orderNumber} delivered${collected ? ` — ${birr(collected)} collected` : ''}. Thank you!` };
  }
  const tries = order.deliveryCodeTries + 1;
  await prisma.order.update({ where: { id: order.id }, data: { deliveryCodeTries: tries } });
  if (tries >= MAX_TRIES) {
    await prisma.driver.update({ where: { id: driver.id }, data: { awaitingOrderId: null } });
    await alertStaff(`🚨 Wrong delivery code ${MAX_TRIES}× for <b>${escapeHtml(order.orderNumber)}</b> (${escapeHtml(driver.name)}). Please check with the customer.`);
    return { text: 'Too many wrong codes — the shop has been told and will confirm with the customer.' };
  }
  return { text: `❌ That code isn’t right. ${MAX_TRIES - tries} tries left — ask the customer again.`, again: true };
}

// ─── Telegram: driver + customer confirmation ────────────

if (bot) {
  // Link: "/driver CODE"
  bot.command('driver', (ctx) => linkDriver(ctx, String(ctx.match ?? '')));
}

/** Links the driver's own Telegram account: from the invite link (/start drv_CODE) or /driver CODE. */
export async function linkDriver(ctx: Context, raw: string) {
  if (ctx.chat?.type !== 'private' || !ctx.from) return;
  const code = raw.trim().toUpperCase();
  const d = code ? await prisma.driver.findUnique({ where: { linkCode: code } }) : null;
  if (!d || !d.isActive) return void (await ctx.reply('This code isn’t valid. Ask the shop for a new one.'));
  await prisma.driver.updateMany({ where: { telegramId: BigInt(ctx.from.id), id: { not: d.id } }, data: { telegramId: null } });
  const linked = await prisma.driver.update({ where: { id: d.id }, data: { telegramId: BigInt(ctx.from.id), linkCode: null, topicId: null } });
  // Own "🛵 Deliveries" topic (when available) + the three buttons — no commands to remember
  const topicId = await ensureDriverTopic(linked);
  if (topicId) await ctx.reply('✅ Connected! Your deliveries have their own topic: “🛵 Deliveries”.');
  await driverSend(
    { ...linked, topicId },
    `✅ Hi ${escapeHtml(d.name)}! You’re a Hikma delivery person.\n\nReady for jobs? Tap “${BTN_ONLINE}”. Stopping? Tap “${BTN_OFFLINE}”.\n\n${LIVE_HOWTO}`,
    { parse_mode: 'HTML', reply_markup: driverKeyboard() },
  );
  void logActivity({ actorName: d.name, action: 'driver.link', summary: `${d.name} connected Telegram`, entity: 'driver', entityId: d.id });
}

if (bot) {
  // Confirm step for "Couldn't deliver" (and the way back)
  bot.callbackQuery(/^dv:([a-z0-9]+):(askfail|back)$/, async (ctx) => {
    const [, orderId, a] = ctx.match;
    if (a === 'askfail') {
      await ctx.answerCallbackQuery({ text: 'Sure? The shop will be alerted.' });
      await ctx
        .editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('⚠️ Yes, I couldn’t deliver', `dv:${orderId}:fail`).row().text('↩️ No, go back', `dv:${orderId}:back`) })
        .catch(() => undefined);
      return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: order ? deliveryKeyboard(order.id, mapLink(order)) : undefined }).catch(() => undefined);
  });

  bot.callbackQuery(/^dv:([a-z0-9]+):(done|fail)$/, async (ctx) => {
    const [, orderId, action] = ctx.match;
    const driver = ctx.from ? await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } }) : null;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!driver || !order || order.driverId !== driver.id) return void (await ctx.answerCallbackQuery({ text: 'This order isn’t assigned to you', show_alert: true }));
    if (order.status !== 'OUT_FOR_DELIVERY') return void (await ctx.answerCallbackQuery({ text: `Already ${order.status.toLowerCase().replace(/_/g, ' ')}` }));
    await ctx.answerCallbackQuery();
    if (action === 'fail') {
      await prisma.orderEvent.create({ data: { orderId: order.id, type: 'internal_delivery_failed', message: `${driver.name} couldn’t deliver` } });
      await alertStaff(`⚠️ <b>${escapeHtml(driver.name)}</b> couldn’t deliver <b>${escapeHtml(order.orderNumber)}</b>. Call the customer: <a href="tel:${order.customerPhone}">${order.customerPhone}</a>`);
      await driverSend(driver, `OK — the shop has been told about ${order.orderNumber}.`);
      return;
    }
    await prisma.driver.update({ where: { id: driver.id }, data: { awaitingOrderId: order.id } });
    await driverSend(driver, `🔐 Type the 4-digit code the customer gives you for ${order.orderNumber}:`, { reply_markup: { force_reply: true, input_field_placeholder: '4-digit code' } });
  });

  // The driver types the code (plain message in the bot chat)
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || !ctx.from || ctx.message.text.startsWith('/') || DRIVER_BUTTONS.includes(ctx.message.text)) return next();
    const reply = await checkDeliveryCode(ctx.from.id, ctx.message.text);
    if (!reply) return next();
    const me = await prisma.driver.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (me) await driverSend(me, reply.text, reply.again ? { reply_markup: { force_reply: true, input_field_placeholder: '4-digit code' } } : { reply_markup: driverKeyboard() });
  });

  // Backup: the customer confirms receipt themselves
  // Customer "I received it" asks once more — it closes the order without the driver's code
  bot.callbackQuery(/^rc:([a-z0-9]+):(ask|back)$/, async (ctx) => {
    const [, orderId, a] = ctx.match;
    await ctx.answerCallbackQuery(a === 'ask' ? { text: 'Is the order in your hands?' } : undefined);
    await ctx
      .editMessageReplyMarkup({
        reply_markup:
          a === 'ask'
            ? new InlineKeyboard().text('✅ Yes, I have it', `rc:${orderId}`).row().text('↩️ Not yet', `rc:${orderId}:back`)
            : new InlineKeyboard().text('✅ I received it', `rc:${orderId}:ask`),
      })
      .catch(() => undefined);
  });

  bot.callbackQuery(/^rc:([a-z0-9]+)$/, async (ctx) => {
    const order = await prisma.order.findUnique({ where: { id: ctx.match[1] } });
    if (!order || !ctx.from || order.telegramChatId?.toString() !== String(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: 'Not your order' }));
    if (order.status !== 'OUT_FOR_DELIVERY') return void (await ctx.answerCallbackQuery({ text: '✅ Already done' }));
    await markDelivered(order.id, 'Customer confirmed they received it');
    await ctx.answerCallbackQuery({ text: '✅ Thank you!' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (order.driverId) await prisma.driver.updateMany({ where: { id: order.driverId, awaitingOrderId: order.id }, data: { awaitingOrderId: null } });
  });
}

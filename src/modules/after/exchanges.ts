/**
 * "Wrong size? Request exchange" — from an order the customer received, within Settings.exchangeDays.
 * Staff get it in the alerts chat and decide in the admin; the customer is told on Telegram.
 */
import { Router } from 'express';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import type { ExchangeRequest } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { requireAuth, requireStaff } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { bot, shopUrl } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

const RECEIVED = ['DELIVERED', 'PICKED_UP'];
export const REASONS: Record<string, string> = { too_small: 'Too small', too_big: 'Too big', defect: 'Defect / damage', other: 'Other' };

type ExItem = { orderItemId: string; name: string; size: string; wantSize: string | null };

function serialize(e: ExchangeRequest) {
  return { id: e.id, orderId: e.orderId, items: e.items as ExItem[], reason: e.reason, note: e.note, status: e.status, staffNote: e.staffNote, createdAt: e.createdAt };
}

/** When the order was received (last status change to delivered / picked up). */
async function receivedAt(orderId: string) {
  const ev = await prisma.orderEvent.findFirst({
    where: { orderId, type: { in: ['status_delivered', 'status_picked_up', 'counter_sale'] } },
    orderBy: { createdAt: 'desc' },
  });
  return ev?.createdAt ?? null;
}

// ─── Customer ────────────────────────────────────────────

export const exchangesRouter = Router();
exchangesRouter.use(requireAuth);

/** Can this order still be exchanged, and the sizes available for each item. */
exchangesRouter.get(
  '/order/:orderNumber',
  ah(async (req, res) => {
    const order = await prisma.order.findFirst({ where: { orderNumber: req.params.orderNumber, userId: req.user!.id }, include: { items: true, exchanges: { orderBy: { createdAt: 'desc' } } } });
    if (!order) throw notFound('Order not found');
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
    const at = RECEIVED.includes(order.status) ? await receivedAt(order.id) : null;
    const until = at ? new Date(at.getTime() + settings.exchangeDays * 86400_000) : null;
    // One exchange per order (a declined request can be asked again)
    const open = order.exchanges.find((e) => e.status !== 'declined');
    const variants = await prisma.productVariant.findMany({
      where: { productId: { in: order.items.map((i) => i.productId) }, isActive: true },
      select: { productId: true, size: true, color: true, stock: true },
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      canRequest: Boolean(until && until > new Date() && !open),
      until,
      days: settings.exchangeDays,
      requests: order.exchanges.map(serialize),
      items: order.items.map((i) => ({
        orderItemId: i.id,
        name: i.productName,
        size: i.size,
        color: i.color,
        image: null,
        sizes: [...new Set(variants.filter((v) => v.productId === i.productId && v.color === i.color && v.size && v.size !== i.size).map((v) => v.size))],
        inStock: Object.fromEntries(variants.filter((v) => v.productId === i.productId && v.color === i.color).map((v) => [v.size, v.stock > 0])),
      })),
    });
  }),
);

exchangesRouter.post(
  '/',
  limiter({ windowMs: 60 * 60_000, limit: 10 }),
  validate(
    z.object({
      orderNumber: z.string().min(3).max(30),
      items: z.array(z.object({ orderItemId: z.string().min(1).max(40), wantSize: z.string().trim().max(20).nullish() })).min(1).max(20),
      reason: z.enum(['too_small', 'too_big', 'defect', 'other']),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  ah(async (req, res) => {
    const body = req.body as { orderNumber: string; items: { orderItemId: string; wantSize?: string | null }[]; reason: string; note?: string };
    const order = await prisma.order.findFirst({ where: { orderNumber: body.orderNumber, userId: req.user!.id }, include: { items: true, exchanges: true } });
    if (!order) throw notFound('Order not found');
    if (!RECEIVED.includes(order.status)) throw conflict('You can ask for an exchange after you receive the order', 'NOT_RECEIVED');
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
    const at = await receivedAt(order.id);
    if (!at || at.getTime() + settings.exchangeDays * 86400_000 < Date.now()) {
      throw conflict(`Exchanges are possible within ${settings.exchangeDays} days of receiving the order`, 'TOO_LATE');
    }
    if (order.exchanges.some((e) => e.status !== 'declined')) throw conflict('This order already has an exchange', 'ALREADY');
    const items: ExItem[] = body.items.map((it) => {
      const oi = order.items.find((x) => x.id === it.orderItemId);
      if (!oi) throw badRequest('Choose items from this order', 'ITEM');
      return { orderItemId: oi.id, name: oi.productName, size: oi.size, wantSize: it.wantSize || null };
    });
    const ex = await prisma.exchangeRequest.create({ data: { orderId: order.id, userId: req.user!.id, items, reason: body.reason, note: body.note || null } });
    await prisma.orderEvent.create({ data: { orderId: order.id, type: 'exchange_requested', message: `Exchange requested: ${REASONS[body.reason]}`, actorId: req.user!.id } });
    void notifyStaff(order.orderNumber, order.id, ex).catch((err) => logger.warn({ err }, 'exchange notice failed'));
    res.status(201).json({ request: serialize(ex) });
  }),
);

async function notifyStaff(orderNumber: string, orderId: string, ex: ExchangeRequest) {
  if (!bot) return;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!s?.adminChatId) return;
  const lines = (ex.items as ExItem[]).map((i) => `• ${escapeHtml(i.name)} ${i.size ? `· ${escapeHtml(i.size)}` : ''}${i.wantSize ? ` → <b>${escapeHtml(i.wantSize)}</b>` : ''}`);
  await bot.api.sendMessage(
    s.adminChatId,
    [`🔁 <b>Exchange request · ${escapeHtml(orderNumber)}</b>`, '', ...lines, '', `Reason: ${REASONS[ex.reason]}`, ex.note ? `“${escapeHtml(ex.note)}”` : ''].filter(Boolean).join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('Open order', shopUrl(`/admin/orders/${orderId}`)) },
  );
}

// ─── Staff ───────────────────────────────────────────────

export const adminExchangesRouter = Router();
adminExchangesRouter.use(requireStaff);

adminExchangesRouter.get(
  '/',
  validate(z.object({ status: z.enum(['requested', 'approved', 'declined', 'done']).optional() }), 'query'),
  ah(async (req, res) => {
    const status = (req.query as { status?: string }).status;
    const list = await prisma.exchangeRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { order: { select: { orderNumber: true, customerName: true, customerPhone: true } } },
    });
    res.json({
      requests: list.map((e) => ({ ...serialize(e), order: e.order })),
      open: await prisma.exchangeRequest.count({ where: { status: 'requested' } }),
    });
  }),
);

adminExchangesRouter.patch(
  '/:id',
  validate(z.object({ status: z.enum(['approved', 'declined', 'done']), staffNote: z.string().trim().max(500).optional() })),
  ah(async (req, res) => {
    const ex = await prisma.exchangeRequest.findUnique({ where: { id: req.params.id }, include: { order: true, user: true } });
    if (!ex) throw notFound('Request not found');
    const { status, staffNote } = req.body as { status: string; staffNote?: string };
    const updated = await prisma.exchangeRequest.update({ where: { id: ex.id }, data: { status, staffNote: staffNote || ex.staffNote } });
    const label = status === 'approved' ? 'Exchange approved' : status === 'declined' ? 'Exchange declined' : 'Exchange completed';
    await prisma.orderEvent.create({ data: { orderId: ex.orderId, type: `exchange_${status}`, message: staffNote ? `${label}: ${staffNote}` : label, actorId: req.user!.id } });
    if (bot && ex.user.telegramId) {
      const am = ex.user.languageCode === 'am';
      const text =
        status === 'approved'
          ? am
            ? `✅ የመቀየር ጥያቄዎ ተቀባይነት አግኝቷል (${ex.order.orderNumber}).${staffNote ? `\n${staffNote}` : ''}`
            : `✅ Your exchange for ${ex.order.orderNumber} is approved.${staffNote ? `\n${staffNote}` : ''}\nBring the item (unworn, with tags) or we’ll arrange a pickup.`
          : status === 'declined'
            ? am
              ? `የመቀየር ጥያቄዎ አልተቀበለም (${ex.order.orderNumber}).${staffNote ? `\n${staffNote}` : ''}`
              : `Your exchange for ${ex.order.orderNumber} wasn’t approved.${staffNote ? `\n${staffNote}` : ''}`
            : am
              ? `🔁 ልውውጡ ተጠናቋል (${ex.order.orderNumber})። እናመሰግናለን!`
              : `🔁 Your exchange for ${ex.order.orderNumber} is done. Thank you!`;
      await bot.api
        .sendMessage(Number(ex.user.telegramId), text, { reply_markup: new InlineKeyboard().webApp('📦  Order', shopUrl(`/orders/${ex.order.orderNumber}`)) })
        .catch(() => undefined);
    }
    res.json({ request: serialize(updated) });
  }),
);

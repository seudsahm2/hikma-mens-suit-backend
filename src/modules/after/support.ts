/**
 * "Need help with this order?" — every problem is tied to its order, so staff always know which
 * order it's about. Customers write from the order page; staff answer from the admin and the reply
 * reaches the customer on Telegram. One open conversation per order (new messages are added to it).
 */
import { Router } from 'express';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import type { SupportRequest } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah, conflict, notFound } from '../../lib/http';
import { requireAuth, requireStaff } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { bot, shopUrl } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

export const TOPICS: Record<string, string> = {
  where: 'Where is my order?',
  payment: 'Payment',
  wrong_item: 'Wrong item',
  damaged: 'Damaged',
  other: 'Other',
};
type Msg = { from: 'customer' | 'staff'; text: string; at: string; by?: string };

const serialize = (r: SupportRequest) => ({
  id: r.id,
  orderId: r.orderId,
  topic: r.topic,
  status: r.status,
  messages: r.messages as Msg[],
  lastFrom: r.lastFrom,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

async function tellStaff(orderNumber: string, orderId: string, topic: string, text: string, customer: string, isNew: boolean) {
  if (!bot) return;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!s?.adminChatId) return;
  await bot.api.sendMessage(
    s.adminChatId,
    [`🆘 <b>${isNew ? 'Help needed' : 'New message'} · ${escapeHtml(orderNumber)}</b>`, `${TOPICS[topic] ?? topic} — ${escapeHtml(customer)}`, '', `“${escapeHtml(text.slice(0, 600))}”`].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('💬  Answer', shopUrl(`/admin/care?order=${orderId}`)) },
  );
}

// ─── Customer ────────────────────────────────────────────

export const supportRouter = Router();
supportRouter.use(requireAuth);

supportRouter.get(
  '/order/:orderNumber',
  ah(async (req, res) => {
    const order = await prisma.order.findFirst({ where: { orderNumber: req.params.orderNumber, userId: req.user!.id }, select: { id: true } });
    if (!order) throw notFound('Order not found');
    const list = await prisma.supportRequest.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    res.set('Cache-Control', 'no-store');
    res.json({ requests: list.map(serialize) });
  }),
);

supportRouter.post(
  '/',
  limiter({ windowMs: 60 * 60_000, limit: 30 }),
  validate(z.object({ orderNumber: z.string().min(3).max(30), topic: z.enum(['where', 'payment', 'wrong_item', 'damaged', 'other']), text: z.string().trim().min(2).max(1000) })),
  ah(async (req, res) => {
    const { orderNumber, topic, text } = req.body as { orderNumber: string; topic: string; text: string };
    const order = await prisma.order.findFirst({ where: { orderNumber, userId: req.user!.id } });
    if (!order) throw notFound('Order not found');
    const msg: Msg = { from: 'customer', text, at: new Date().toISOString() };
    const open = await prisma.supportRequest.findFirst({ where: { orderId: order.id, status: 'open' } });
    const r = open
      ? await prisma.supportRequest.update({ where: { id: open.id }, data: { messages: [...(open.messages as Msg[]), msg], lastFrom: 'customer' } })
      : await prisma.supportRequest.create({ data: { orderId: order.id, userId: req.user!.id, topic, messages: [msg] } });
    if (!open) await prisma.orderEvent.create({ data: { orderId: order.id, type: 'help_requested', message: `Customer asked for help: ${TOPICS[topic]}`, actorId: req.user!.id } });
    void tellStaff(order.orderNumber, order.id, r.topic, text, order.customerName, !open).catch((err) => logger.warn({ err }, 'help notice failed'));
    res.status(open ? 200 : 201).json({ request: serialize(r) });
  }),
);

// ─── Staff ───────────────────────────────────────────────

export const adminSupportRouter = Router();
adminSupportRouter.use(requireStaff);

adminSupportRouter.get(
  '/',
  validate(z.object({ status: z.enum(['open', 'solved']).optional(), order: z.string().max(40).optional() }), 'query'),
  ah(async (req, res) => {
    const { status, order } = req.query as { status?: string; order?: string };
    const list = await prisma.supportRequest.findMany({
      where: { ...(status ? { status } : {}), ...(order ? { orderId: order } : {}) },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 100,
      include: { order: { select: { orderNumber: true, customerName: true, customerPhone: true, status: true, user: { select: { telegramUsername: true } } } } },
    });
    res.json({
      requests: list.map((r) => ({ ...serialize(r), order: { ...r.order, telegramUsername: r.order.user?.telegramUsername ?? null } })),
      open: await prisma.supportRequest.count({ where: { status: 'open' } }),
    });
  }),
);

adminSupportRouter.post(
  '/:id/reply',
  validate(z.object({ text: z.string().trim().min(1).max(1000), solve: z.boolean().default(false) })),
  ah(async (req, res) => {
    const r = await prisma.supportRequest.findUnique({ where: { id: req.params.id }, include: { order: true, user: true } });
    if (!r) throw notFound('Conversation not found');
    if (r.status === 'solved' && !req.body.solve) throw conflict('This conversation is solved — reopen it first', 'SOLVED');
    const by = req.user!.fullName;
    const msg: Msg = { from: 'staff', text: req.body.text, at: new Date().toISOString(), by };
    const updated = await prisma.supportRequest.update({
      where: { id: r.id },
      data: { messages: [...(r.messages as Msg[]), msg], lastFrom: 'staff', ...(req.body.solve ? { status: 'solved' } : {}) },
    });
    if (bot && r.user.telegramId) {
      const am = r.user.languageCode === 'am';
      await bot.api
        .sendMessage(Number(r.user.telegramId), `💬 <b>Hikma · ${escapeHtml(r.order.orderNumber)}</b>\n${escapeHtml(req.body.text)}`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp(am ? '↩️  መልስ' : '↩️  Reply', shopUrl(`/orders/${r.order.orderNumber}?help=1`)),
        })
        .catch(() => undefined);
    }
    res.json({ request: serialize(updated) });
  }),
);

adminSupportRouter.patch(
  '/:id',
  validate(z.object({ status: z.enum(['open', 'solved']) })),
  ah(async (req, res) => {
    const r = await prisma.supportRequest.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    if (req.body.status === 'solved') await prisma.orderEvent.create({ data: { orderId: r.orderId, type: 'help_solved', message: 'Help request solved', actorId: req.user!.id } });
    res.json({ request: serialize(r) });
  }),
);

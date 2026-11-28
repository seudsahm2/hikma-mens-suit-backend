import { Router } from 'express';
import { limiter } from '../../middleware/rateLimit';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, forbidden, notFound } from '../../lib/http';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { saveImage } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { getSettings } from '../settings/settings.service';
import { createOrder, orderInclude, serializeOrder, submitPayment } from './orders.service';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const orderLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 30 });

const createSchema = z.object({
  items: z
    .array(z.object({ variantId: z.string().min(1).max(40), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(30),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().min(9).max(20),
  deliveryOptionId: z.string().min(1).max(40),
  city: z.string().trim().max(60).optional(),
  area: z.string().trim().max(80).optional(),
  landmark: z.string().trim().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  paymentMethodId: z.string().min(1).max(40),
  payDeposit: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
  source: z.enum(['WEB', 'MINI_APP']).default('WEB'),
  code: z.string().trim().max(40).optional(),
  invite: z.string().trim().max(40).optional(),
  useCredit: z.boolean().default(false),
});

/** True if the signed-in buyer is the shop owner (either their OWNER row or a customer row sharing the owner's Telegram/phone). */
async function isOwnerBuyer(user: User): Promise<boolean> {
  if (user.role === 'OWNER') return true;
  if (user.telegramId != null) {
    const match = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true, staffTelegramId: user.telegramId }, select: { id: true } });
    if (match) return true;
  }
  if (user.phone) {
    const match = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true, phone: user.phone }, select: { id: true } });
    if (match) return true;
  }
  return false;
}

ordersRouter.post(
  '/',
  orderLimiter,
  validate(createSchema),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const phone = normalizeEthiopianPhone(body.customerPhone);
    if (!phone) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
    const settings = await getSettings();
    if (!settings.ownerCanOrder && (await isOwnerBuyer(req.user!))) {
      throw forbidden('Owner ordering is turned off in Settings → Telegram');
    }
    const order = await createOrder(req.user!, { ...body, customerPhone: phone });
    res.status(201).json({ order: serializeOrder(order) });
  }),
);

ordersRouter.get(
  '/mine',
  ah(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
      take: 50,
    });
    res.json({ orders: orders.map((o) => serializeOrder(o)) });
  }),
);

async function findOwnOrder(orderNumber: string, userId: string, isStaff: boolean) {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
  if (!order || (!isStaff && order.userId !== userId)) throw notFound('Order not found');
  return order;
}

/** Customer rates the delivery person (once, delivered orders). */
ordersRouter.post(
  '/:orderNumber/rate-driver',
  validate(z.object({ stars: z.number().int().min(1).max(5), note: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const order = await prisma.order.findFirst({ where: { orderNumber: req.params.orderNumber, userId: req.user!.id } });
    if (!order) throw notFound('Order not found');
    const { rateDelivery } = await import('../delivery/driverProfile');
    res.json({ stars: await rateDelivery(order.id, req.body.stars, { userId: req.user!.id }, req.body.note) });
  }),
);

ordersRouter.get(
  '/:orderNumber',
  ah(async (req, res) => {
    const order = await findOwnOrder(req.params.orderNumber!, req.user!.id, req.user!.role !== 'CUSTOMER');
    res.json({ order: serializeOrder(order) });
  }),
);

ordersRouter.post(
  '/:orderNumber/payment',
  orderLimiter,
  imageUpload.single('proof'),
  ah(async (req, res) => {
    const order = await findOwnOrder(req.params.orderNumber!, req.user!.id, false);
    const transactionRef = typeof req.body.transactionRef === 'string' ? req.body.transactionRef.trim().slice(0, 64) : '';
    let proofKey: string | undefined;
    if (req.file) proofKey = (await saveImage(req.file.buffer, 'proofs')).key;
    const updated = await submitPayment(order.id, { transactionRef: transactionRef || undefined, proofKey });
    res.json({ order: serializeOrder(updated) });
  }),
);

/**
 * "Send to my Telegram": the receipt image made on the customer's phone is sent to their own chat
 * with the bot — saving / forwarding works there everywhere (inside Telegram, downloads often don't).
 */
ordersRouter.post(
  '/:orderNumber/receipt',
  limiter({ windowMs: 60 * 60_000, limit: 20 }),
  imageUpload.single('image'),
  ah(async (req, res) => {
    const order = await prisma.order.findFirst({ where: { orderNumber: req.params.orderNumber, userId: req.user!.id } });
    if (!order) throw notFound('Order not found');
    const file = req.file;
    if (!file || file.mimetype !== 'image/png' || file.size > 4 * 1024 * 1024) throw badRequest('Receipt image missing', 'NO_IMAGE');
    const chatId = req.user!.telegramId;
    const { bot } = await import('../telegram/bot');
    if (!bot) throw badRequest('Telegram isn’t available right now — use Save image instead', 'TELEGRAM_OFF');
    if (!chatId) throw badRequest('Sign in with Telegram to receive it there', 'NO_TELEGRAM');
    const { InputFile } = await import('grammy');
    try {
      await bot.api.sendDocument(Number(chatId), new InputFile(file.buffer, `Hikma-${order.orderNumber}.png`), {
        caption: `🧾 Receipt · ${order.orderNumber}`,
      });
    } catch {
      throw badRequest('We couldn’t reach your Telegram — open @' + (await import('../../config/env')).env.TELEGRAM_BOT_USERNAME + ' and tap Start, then try again', 'TELEGRAM_BLOCKED');
    }
    res.json({ ok: true });
  }),
);

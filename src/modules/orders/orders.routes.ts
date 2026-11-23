import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/http';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { saveImage } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { createOrder, orderInclude, serializeOrder, submitPayment } from './orders.service';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

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
});

ordersRouter.post(
  '/',
  orderLimiter,
  validate(createSchema),
  ah(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const phone = normalizeEthiopianPhone(body.customerPhone);
    if (!phone) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
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

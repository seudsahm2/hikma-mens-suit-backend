import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/http';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { validate } from '../../middleware/validate';
import { changeStatus, createOrder, orderInclude, reviewPayment, serializeOrder } from '../orders/orders.service';

export const adminOrdersRouter = Router();

const STATUSES = ['PENDING', 'CONFIRMED', 'PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'] as const;
const PAYMENT = ['UNPAID', 'SUBMITTED', 'PARTIAL', 'PAID', 'REJECTED'] as const;

const listQuery = z.object({
  status: z.enum([...STATUSES, 'OPEN']).optional(),
  payment: z.enum(PAYMENT).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

adminOrdersRouter.get(
  '/',
  validate(listQuery, 'query'),
  ah(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where: Prisma.OrderWhereInput = {
      ...(q.status === 'OPEN'
        ? { status: { in: ['PENDING', 'CONFIRMED', 'PACKING', 'OUT_FOR_DELIVERY'] } }
        : q.status
          ? { status: q.status }
          : {}),
      ...(q.payment ? { paymentStatus: q.payment } : {}),
      ...(q.q
        ? {
            OR: [
              { orderNumber: { contains: q.q, mode: 'insensitive' } },
              { customerName: { contains: q.q, mode: 'insensitive' } },
              { customerPhone: { contains: q.q } },
              { transactionRef: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, orders, counts] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prisma.order.groupBy({ by: ['paymentStatus'], where: { status: { not: 'CANCELLED' } }, _count: true }),
    ]);
    res.json({
      orders: orders.map((o) => serializeOrder(o, { staff: true })),
      total,
      page: q.page,
      hasMore: q.page * q.limit < total,
      needsReview: counts.find((c) => c.paymentStatus === 'SUBMITTED')?._count ?? 0,
    });
  }),
);

adminOrdersRouter.get(
  '/:id',
  ah(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
    if (!order) throw notFound('Order not found');
    res.json({ order: serializeOrder(order, { staff: true }) });
  }),
);

adminOrdersRouter.patch(
  '/:id/status',
  validate(z.object({ status: z.enum(STATUSES), note: z.string().trim().max(300).optional() })),
  ah(async (req, res) => {
    const order = await changeStatus(req.params.id!, req.body.status, req.user!.id, req.body.note);
    res.json({ order: serializeOrder(order, { staff: true }) });
  }),
);

adminOrdersRouter.patch(
  '/:id/payment',
  validate(
    z.object({
      approve: z.boolean(),
      amountPaid: z.number().int().min(0).optional(),
      reason: z.string().trim().max(300).optional(),
    }),
  ),
  ah(async (req, res) => {
    const order = await reviewPayment(req.params.id!, req.user!.id, req.body);
    res.json({ order: serializeOrder(order, { staff: true }) });
  }),
);

adminOrdersRouter.patch(
  '/:id/note',
  validate(z.object({ message: z.string().trim().min(1).max(500) })),
  ah(async (req, res) => {
    await prisma.orderEvent.create({
      data: { orderId: req.params.id!, type: 'internal_note', message: req.body.message, actorId: req.user!.id },
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude });
    res.json({ order: serializeOrder(order, { staff: true }) });
  }),
);

/** Manual order for walk-in or Telegram-DM sales. */
adminOrdersRouter.post(
  '/',
  validate(
    z.object({
      items: z.array(z.object({ variantId: z.string(), quantity: z.number().int().min(1).max(50) })).min(1).max(30),
      customerName: z.string().trim().min(2).max(80),
      customerPhone: z.string().trim().min(9).max(20),
      deliveryOptionId: z.string(),
      area: z.string().trim().max(80).optional(),
      landmark: z.string().trim().max(200).optional(),
      paymentMethodId: z.string(),
      markPaid: z.boolean().default(false),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  ah(async (req, res) => {
    const phone = normalizeEthiopianPhone(req.body.customerPhone);
    if (!phone) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
    const actorId = req.user!.id;
    let order = await createOrder(null, { ...req.body, customerPhone: phone, payDeposit: false, source: 'ADMIN' }, actorId);
    if (req.body.markPaid) order = await reviewPayment(order.id, actorId, { approve: true, amountPaid: order.total });
    res.status(201).json({ order: serializeOrder(order, { staff: true }) });
  }),
);

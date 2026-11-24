import { Router } from 'express';
import { z } from 'zod';
import { startOfAddisDay } from '../../lib/addisTime';
import { ah, badRequest } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { validate } from '../../middleware/validate';
import { serializeOrder } from '../orders/orders.service';
import { counterSalesSince, createCounterSale, UNDO_HOURS, undoCounterSale } from '../orders/counterSale';

/** Shop counter: walk-in sales (staff). */
export const adminCounterRouter = Router();

adminCounterRouter.get(
  '/today',
  ah(async (_req, res) => {
    const [sales, methods] = await Promise.all([
      counterSalesSince(startOfAddisDay()),
      // Cash is always possible at the counter, plus the wallets/banks the shop uses
      prisma.paymentMethod.findMany({ where: { OR: [{ id: 'cash' }, { isEnabled: true }] }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const live = sales.filter((s) => s.status !== 'CANCELLED');
    res.json({
      sales: sales.map((s) => serializeOrder(s, { staff: true })),
      total: live.reduce((n, s) => n + s.total, 0),
      pieces: live.reduce((n, s) => n + s.items.reduce((m, i) => m + i.quantity, 0), 0),
      undoHours: UNDO_HOURS,
      paymentMethods: [
        { id: 'cash', name: 'Cash' },
        ...methods.filter((m) => m.id !== 'cash').map((m) => ({ id: m.id, name: m.name })),
      ],
    });
  }),
);

adminCounterRouter.post(
  '/',
  validate(
    z.object({
      items: z
        .array(
          z.object({
            variantId: z.string().min(1),
            quantity: z.number().int().min(1).max(50),
            unitPrice: z.number().int().min(0).max(10_000_000).optional(),
          }),
        )
        .min(1)
        .max(30),
      paymentMethodId: z.string().min(1),
      customerName: z.string().trim().max(80).optional(),
      customerPhone: z.string().trim().max(20).optional(),
      note: z.string().trim().max(300).optional(),
    }),
  ),
  ah(async (req, res) => {
    let phone: string | undefined;
    if (req.body.customerPhone) {
      phone = normalizeEthiopianPhone(req.body.customerPhone) ?? undefined;
      if (!phone) throw badRequest('Enter a valid Ethiopian phone number, or leave it empty', 'PHONE');
    }
    const order = await createCounterSale({ ...req.body, customerPhone: phone }, req.user!.id);
    res.status(201).json({ order: serializeOrder(order, { staff: true }) });
  }),
);

adminCounterRouter.post(
  '/:id/undo',
  ah(async (req, res) => {
    const order = await undoCounterSale(req.params.id!, req.user!.id);
    res.json({ order: serializeOrder(order, { staff: true }) });
  }),
);

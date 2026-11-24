import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, conflict, notFound } from '../../lib/http';
import { requireAuth } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';

/** Customer "Notify me when back" subscriptions (Telegram sign-in required — that's where we notify). */
export const alertsRouter = Router();
alertsRouter.use(requireAuth);

/** Which sizes of this product the customer is waiting for. */
alertsRouter.get(
  '/',
  validate(z.object({ productId: z.string().min(1).max(40) }), 'query'),
  ah(async (req, res) => {
    const { productId } = req.query as unknown as { productId: string };
    const alerts = await prisma.stockAlert.findMany({
      where: { userId: req.user!.id, notifiedAt: null, variant: { productId } },
      select: { variantId: true },
    });
    res.json({ variantIds: alerts.map((a) => a.variantId) });
  }),
);

alertsRouter.post(
  '/',
  limiter({ windowMs: 60 * 60 * 1000, limit: 100 }),
  validate(z.object({ variantId: z.string().min(1).max(40) })),
  ah(async (req, res) => {
    const variant = await prisma.productVariant.findFirst({
      where: { id: req.body.variantId, isActive: true, product: { status: 'ACTIVE' } },
    });
    if (!variant) throw notFound('This item is no longer available');
    if (variant.stock > 0) throw conflict('It’s in stock now — you can order it', 'IN_STOCK');
    await prisma.stockAlert.upsert({
      where: { userId_variantId: { userId: req.user!.id, variantId: variant.id } },
      create: { userId: req.user!.id, variantId: variant.id },
      update: { notifiedAt: null, createdAt: new Date() }, // re-subscribe after an earlier notification
    });
    res.status(201).json({ ok: true });
  }),
);

alertsRouter.delete(
  '/:variantId',
  ah(async (req, res) => {
    await prisma.stockAlert.deleteMany({ where: { userId: req.user!.id, variantId: req.params.variantId } });
    res.json({ ok: true });
  }),
);

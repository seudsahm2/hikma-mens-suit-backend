/**
 * "Wrong size? Request exchange" — from an order the customer received, within Settings.exchangeDays.
 * Staff get it in the alerts chat and decide in the admin; the customer is told on Telegram.
 */
import { Router } from 'express';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import type { ExchangeRequest, ProductKind } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { requireAuth, requireStaff } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { bot, shopUrl } from '../telegram/bot';
import { birr, escapeHtml } from '../telegram/media';

const RECEIVED = ['DELIVERED', 'PICKED_UP'];
export const REASONS: Record<string, string> = {
  too_small: 'Too small',
  too_big: 'Too big',
  wrong_scent: 'Wrong scent / item',
  damaged_bottle: 'Damaged bottle / leak',
  wrong_item: 'Wrong item',
  defect: 'Defect / damage',
  other: 'Other',
};

export const REASONS_BY_KIND: Record<ProductKind, string[]> = {
  APPAREL: ['too_small', 'too_big', 'defect', 'other'],
  FOOTWEAR: ['too_small', 'too_big', 'defect', 'other'],
  FRAGRANCE: ['wrong_scent', 'damaged_bottle', 'defect', 'other'],
  ACCESSORY: ['wrong_item', 'defect', 'other'],
};

type ExItem = {
  orderItemId: string;
  name: string;
  size: string;
  wantSize: string | null;
  wantVariantId?: string | null;
};

function computeExchangeFee(s: { exchangeFeeType: string; exchangeFeeValue: number }, orderSubtotal: number, reason: string) {
  if (reason === 'defect' || reason === 'damaged_bottle') return 0;
  if (s.exchangeFeeType === 'fixed') return Math.max(0, s.exchangeFeeValue);
  if (s.exchangeFeeType === 'percent') return Math.max(0, Math.round((orderSubtotal * s.exchangeFeeValue) / 100));
  return 0;
}

function serialize(e: ExchangeRequest) {
  return {
    id: e.id,
    orderId: e.orderId,
    items: e.items as ExItem[],
    reason: e.reason,
    note: e.note,
    status: e.status,
    staffNote: e.staffNote,
    replacementOrderId: e.replacementOrderId,
    deliveryFee: e.deliveryFee,
    returnStatus: e.returnStatus,
    damagePhotoUrl: e.damagePhotoKey ? imageUrls(e.damagePhotoKey).md : null,
    damageFee: e.damageFee,
    damagePaid: e.damagePaid,
    damageNote: e.damageNote,
    createdAt: e.createdAt,
  };
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
    const [variants, products] = await Promise.all([
      prisma.productVariant.findMany({
        where: { productId: { in: order.items.map((i) => i.productId) }, isActive: true },
        select: { id: true, productId: true, size: true, color: true, stock: true },
      }),
      prisma.product.findMany({
        where: { id: { in: order.items.map((i) => i.productId) } },
        select: { id: true, category: { select: { kind: true } } },
      }),
    ]);
    const kindOf = new Map(products.map((p) => [p.id, p.category.kind]));
    res.set('Cache-Control', 'no-store');
    res.json({
      canRequest: Boolean(until && until > new Date() && !open),
      until,
      days: settings.exchangeDays,
      requests: order.exchanges.map(serialize),
      items: order.items.map((i) => {
        const kind = kindOf.get(i.productId) ?? 'APPAREL';
        const matching = variants.filter((v) => v.productId === i.productId && v.color === i.color);
        return {
          orderItemId: i.id,
          name: i.productName,
          size: i.size,
          color: i.color,
          kind,
          reasons: REASONS_BY_KIND[kind],
          image: null,
          sizes: [...new Set(matching.filter((v) => v.size && v.size !== i.size).map((v) => v.size))],
          variants: matching.map((v) => ({ id: v.id, size: v.size, color: v.color, stock: v.stock })),
          inStock: Object.fromEntries(matching.map((v) => [v.size, v.stock > 0])),
        };
      }),
    });
  }),
);

exchangesRouter.post(
  '/',
  limiter({ windowMs: 60 * 60_000, limit: 10 }),
  validate(
    z.object({
      orderNumber: z.string().min(3).max(30),
      items: z
        .array(
          z.object({
            orderItemId: z.string().min(1).max(40),
            wantSize: z.string().trim().max(20).nullish(),
            wantVariantId: z.string().trim().max(40).nullish(),
          }),
        )
        .min(1)
        .max(20),
      reason: z.enum(['too_small', 'too_big', 'wrong_scent', 'damaged_bottle', 'wrong_item', 'defect', 'other']),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  ah(async (req, res) => {
    const body = req.body as {
      orderNumber: string;
      items: { orderItemId: string; wantSize?: string | null; wantVariantId?: string | null }[];
      reason: string;
      note?: string;
    };
    const order = await prisma.order.findFirst({ where: { orderNumber: body.orderNumber, userId: req.user!.id }, include: { items: true, exchanges: true } });
    if (!order) throw notFound('Order not found');
    if (!RECEIVED.includes(order.status)) throw conflict('You can ask for an exchange after you receive the order', 'NOT_RECEIVED');
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
    const at = await receivedAt(order.id);
    if (!at || at.getTime() + settings.exchangeDays * 86400_000 < Date.now()) {
      throw conflict(`Exchanges are possible within ${settings.exchangeDays} days of receiving the order`, 'TOO_LATE');
    }
    if (order.exchanges.some((e) => e.status !== 'declined')) throw conflict('This order already has an exchange', 'ALREADY');
    const allVariants = await prisma.productVariant.findMany({
      where: { productId: { in: order.items.map((i) => i.productId) }, isActive: true },
      select: { id: true, productId: true, color: true, size: true },
    });
    const items: ExItem[] = body.items.map((it) => {
      const oi = order.items.find((x) => x.id === it.orderItemId);
      if (!oi) throw badRequest('Choose items from this order', 'ITEM');
      const matched = it.wantVariantId
        ? allVariants.find((v) => v.id === it.wantVariantId)
        : it.wantSize
          ? allVariants.find((v) => v.productId === oi.productId && v.color === oi.color && v.size === it.wantSize)
          : undefined;
      return {
        orderItemId: oi.id,
        name: oi.productName,
        size: oi.size,
        wantSize: it.wantSize ?? matched?.size ?? null,
        wantVariantId: matched?.id ?? null,
      };
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
    const [list, settings] = await Promise.all([
      prisma.exchangeRequest.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { order: { select: { id: true, orderNumber: true, customerName: true, customerPhone: true, subtotal: true, items: true } } },
      }),
      prisma.settings.findUniqueOrThrow({ where: { id: 'default' } }),
    ]);
    const productIds = [...new Set(list.flatMap((e) => e.order.items.map((i) => i.productId)))];
    const variants = productIds.length
      ? await prisma.productVariant.findMany({ where: { productId: { in: productIds }, isActive: true }, select: { id: true, productId: true, size: true, color: true, stock: true } })
      : [];
    res.json({
      requests: list.map((e) => {
        const orderItems = e.order.items;
        const itemOptions = (e.items as ExItem[]).map((it) => {
          const oi = orderItems.find((x) => x.id === it.orderItemId);
          const choices = oi ? variants.filter((v) => v.productId === oi.productId) : [];
          return { ...it, choices };
        });
        return {
          ...serialize(e),
          items: itemOptions,
          defaultDeliveryFee: computeExchangeFee(settings, e.order.subtotal, e.reason),
          order: { orderNumber: e.order.orderNumber, customerName: e.order.customerName, customerPhone: e.order.customerPhone },
        };
      }),
      open: await prisma.exchangeRequest.count({ where: { status: 'requested' } }),
    });
  }),
);

/**
 * 1-step "Prepare Exchange Delivery":
 *  - atomically reserves stock for the replacement variant(s)
 *  - creates a linked replacement Order in PACKING (ready for driver dispatch)
 *  - marks the ExchangeRequest approved (with deliveryFee override if set)
 */
adminExchangesRouter.post(
  '/:id/prepare',
  validate(
    z.object({
      items: z.array(z.object({ orderItemId: z.string().min(1), variantId: z.string().min(1) })).min(1).max(20),
      deliveryFee: z.number().int().min(0).max(100_000).optional(),
      staffNote: z.string().trim().max(500).optional(),
    }),
  ),
  ah(async (req, res) => {
    const ex = await prisma.exchangeRequest.findUnique({ where: { id: req.params.id }, include: { order: { include: { items: true } }, user: true } });
    if (!ex) throw notFound('Request not found');
    if (ex.replacementOrderId) throw conflict('Replacement delivery is already prepared for this exchange', 'ALREADY');
    if (ex.status === 'declined' || ex.status === 'done') throw conflict('This exchange is already closed', 'CLOSED');

    const body = req.body as { items: { orderItemId: string; variantId: string }[]; deliveryFee?: number; staffNote?: string };
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
    const fee = body.deliveryFee ?? computeExchangeFee(settings, ex.order.subtotal, ex.reason);

    const { replacement, updated } = await prisma.$transaction(async (tx) => {
      const replItems: { variantId: string; productId: string; productName: string; size: string; color: string; imageKey: string | null; quantity: number }[] = [];
      for (const pick of body.items) {
        const oi = ex.order.items.find((x) => x.id === pick.orderItemId);
        if (!oi) throw badRequest('Invalid order item', 'ITEM');
        const v = await tx.productVariant.findUnique({ where: { id: pick.variantId }, include: { product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } } });
        if (!v || !v.isActive) throw conflict('Selected replacement variant is unavailable', 'UNAVAILABLE');
        const dec = await tx.productVariant.updateMany({ where: { id: v.id, stock: { gte: oi.quantity } }, data: { stock: { decrement: oi.quantity } } });
        if (!dec.count) throw conflict(`${v.product.nameEn} (${v.size}) is out of stock`, 'OUT_OF_STOCK');
        await tx.stockMovement.create({ data: { variantId: v.id, delta: -oi.quantity, reason: 'ORDER', actorId: req.user!.id } });
        replItems.push({
          variantId: v.id,
          productId: v.productId,
          productName: v.product.nameEn,
          size: v.size,
          color: v.color,
          imageKey: v.product.images[0]?.key ?? oi.imageKey,
          quantity: oi.quantity,
        });
      }

      const replNumber = `${ex.order.orderNumber}-EX`;
      const createdOrder = await tx.order.create({
        data: {
          orderNumber: replNumber,
          exchangeId: ex.id,
          userId: ex.order.userId,
          source: 'ADMIN',
          customerName: ex.order.customerName,
          customerPhone: ex.order.customerPhone,
          customerPhoneVerified: ex.order.customerPhoneVerified,
          telegramChatId: ex.order.telegramChatId,
          deliveryOptionId: ex.order.deliveryOptionId === 'pickup' ? 'addis_free' : ex.order.deliveryOptionId,
          deliveryLabel: 'Exchange delivery',
          city: ex.order.city,
          area: ex.order.area,
          landmark: ex.order.landmark,
          lat: ex.order.lat,
          lng: ex.order.lng,
          subtotal: 0,
          deliveryFee: fee,
          total: fee,
          amountDue: fee,
          amountPaid: 0,
          costTotal: 0,
          paymentMethodId: 'cash',
          paymentLabel: fee > 0 ? 'Pay on exchange delivery' : 'Free exchange',
          paymentStatus: fee > 0 ? 'UNPAID' : 'PAID',
          status: 'PACKING',
          note: `Exchange for ${ex.order.orderNumber}${body.staffNote ? ` — ${body.staffNote}` : ''}`,
          items: {
            create: replItems.map((it) => ({
              variantId: it.variantId,
              productId: it.productId,
              productName: it.productName,
              size: it.size,
              color: it.color,
              imageKey: it.imageKey,
              unitPrice: 0,
              costPrice: 0,
              quantity: it.quantity,
            })),
          },
          events: {
            create: { type: 'exchange_prepared', message: `Replacement prepared for ${ex.order.orderNumber}${fee > 0 ? ` · delivery fee ${birr(fee)}` : ' · free delivery'}`, actorId: req.user!.id },
          },
        },
      });

      const updEx = await tx.exchangeRequest.update({
        where: { id: ex.id },
        data: { status: 'approved', replacementOrderId: createdOrder.id, deliveryFee: fee, staffNote: body.staffNote || ex.staffNote },
      });
      await tx.orderEvent.create({
        data: { orderId: ex.orderId, type: 'exchange_approved', message: `Exchange prepared (${replNumber})`, actorId: req.user!.id },
      });
      return { replacement: createdOrder, updated: updEx };
    });

    if (bot && ex.user.telegramId) {
      const am = ex.user.languageCode === 'am';
      const feeLine = fee > 0 ? (am ? `\nየማድረሻ ክፍያ: ${birr(fee)}` : `\nDelivery fee: ${birr(fee)}`) : '';
      const msg = am
        ? `✅ የመቀየር ጥያቄዎ (${ex.order.orderNumber}) ተዘጋጅቷል! አዲሱ ትዕዛዝ: ${replacement.orderNumber}${feeLine}${body.staffNote ? `\n${body.staffNote}` : ''}`
        : `✅ Your exchange for ${ex.order.orderNumber} is approved and being packed (${replacement.orderNumber}).${feeLine}${body.staffNote ? `\n${body.staffNote}` : ''}\nPlease have the original item ready for the driver.`;
      await bot.api.sendMessage(Number(ex.user.telegramId), msg, { reply_markup: new InlineKeyboard().webApp('📦  Order', shopUrl(`/orders/${replacement.orderNumber}`)) }).catch(() => undefined);
    }
    void import('../telegram/notify').then((n) => n.notifyOrderEvent(replacement.id, 'placed')).catch(() => undefined);
    res.json({ request: serialize(updated), replacementOrderId: replacement.id, replacementOrderNumber: replacement.orderNumber });
  }),
);

/** Restock returned original items (only when returned in good condition). */
adminExchangesRouter.post(
  '/:id/restock',
  ah(async (req, res) => {
    const ex = await prisma.exchangeRequest.findUnique({ where: { id: req.params.id }, include: { order: { include: { items: true } } } });
    if (!ex) throw notFound('Request not found');
    if (ex.returnStatus === 'restocked') throw conflict('Already restocked', 'ALREADY');
    if (ex.returnStatus !== 'returned_good') throw conflict('Only items returned in good condition can be restocked', 'NOT_GOOD');
    const items = ex.items as ExItem[];
    const updated = await prisma.$transaction(async (tx) => {
      for (const it of items) {
        const oi = ex.order.items.find((x) => x.id === it.orderItemId);
        if (!oi) continue;
        await tx.productVariant.updateMany({ where: { id: oi.variantId }, data: { stock: { increment: oi.quantity } } });
        await tx.stockMovement.create({ data: { variantId: oi.variantId, delta: oi.quantity, reason: 'RESTOCK', orderId: ex.orderId, actorId: req.user!.id } });
      }
      await tx.orderEvent.create({ data: { orderId: ex.orderId, type: 'exchange_restocked', message: 'Returned item restocked', actorId: req.user!.id } });
      return tx.exchangeRequest.update({ where: { id: ex.id }, data: { returnStatus: 'restocked', status: 'done' } });
    });
    res.json({ request: serialize(updated) });
  }),
);

/** Owner sets a damage fee for a damaged return and notifies customer + driver. */
adminExchangesRouter.post(
  '/:id/damage-fee',
  validate(z.object({ amount: z.number().int().min(0).max(1_000_000), note: z.string().trim().max(300).optional() })),
  ah(async (req, res) => {
    const ex = await prisma.exchangeRequest.findUnique({ where: { id: req.params.id }, include: { order: true, user: true } });
    if (!ex) throw notFound('Request not found');
    const { amount, note } = req.body as { amount: number; note?: string };
    const updated = await prisma.exchangeRequest.update({
      where: { id: ex.id },
      data: { damageFee: amount, damageNote: note ?? ex.damageNote, damagePaid: amount === 0 },
    });
    await prisma.orderEvent.create({ data: { orderId: ex.orderId, type: 'exchange_damage_fee', message: `Damage fee set: ${birr(amount)}${note ? ` — ${note}` : ''}`, actorId: req.user!.id } });
    if (bot && ex.user.telegramId && amount > 0) {
      const am = ex.user.languageCode === 'am';
      const targetOrder = ex.replacementOrderId
        ? (await prisma.order.findUnique({ where: { id: ex.replacementOrderId }, select: { orderNumber: true } }))?.orderNumber ?? ex.order.orderNumber
        : ex.order.orderNumber;
      const text = am
        ? `⚠️ በተመለሰው ዕቃ (${ex.order.orderNumber}) ላይ ጉዳት ስለተገኘ ${birr(amount)} ክፍያ ተወስኗል።${note ? `\n${note}` : ''}`
        : `⚠️ Damage fee for returned item (${ex.order.orderNumber}): <b>${birr(amount)}</b>.${note ? `\n${note}` : ''}\nPay cash to the driver or via Telebirr/bank on your order page.`;
      await bot.api.sendMessage(Number(ex.user.telegramId), text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().webApp(am ? 'ትዕዛዙን ይመልከቱ' : 'View order', shopUrl(`/orders/${targetOrder}`)),
      }).catch(() => undefined);
    }
    res.json({ request: serialize(updated) });
  }),
);

adminExchangesRouter.post(
  '/:id/damage-paid',
  ah(async (req, res) => {
    const ex = await prisma.exchangeRequest.findUnique({ where: { id: req.params.id } });
    if (!ex) throw notFound('Request not found');
    const updated = await prisma.exchangeRequest.update({ where: { id: ex.id }, data: { damagePaid: true, status: 'done' } });
    await prisma.orderEvent.create({ data: { orderId: ex.orderId, type: 'exchange_damage_paid', message: `Damage fee marked paid (${birr(ex.damageFee)})`, actorId: req.user!.id } });
    res.json({ request: serialize(updated) });
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

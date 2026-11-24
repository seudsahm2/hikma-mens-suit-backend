import { randomInt } from 'node:crypto';
import type { Order, OrderEvent, OrderItem, OrderSource, OrderStatus, Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http';
import { imageUrls } from '../../lib/storage';
import { getSettings } from '../settings/settings.service';
import { canAutoVerify, verifyTransaction } from '../payments/shegerpay';
import { notifyOrderEvent } from '../telegram/notify';
import { onStockRestored } from '../alerts/backInStock';
import { canMoveTo, isFinalStatus, STATUS_LABEL } from './rules';
import { mergeSizeProfile } from '../../lib/sizeProfile';
import { creditBalance, quote, type DiscountLine } from '../pricing/pricing';
import { onOrderCancelled, onOrderPlaced, onOrderReceived, safely } from '../pricing/rewards';
export { canMoveTo, isFinalStatus, STATUS_LABEL } from './rules';

// ─── Serialisation ───────────────────────────────────────

type OrderWithRelations = Order & { items: OrderItem[]; events?: OrderEvent[] };

export function serializeOrder(o: OrderWithRelations, opts: { staff?: boolean } = {}) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    source: o.source,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    delivery: {
      optionId: o.deliveryOptionId,
      label: o.deliveryLabel,
      city: o.city,
      area: o.area,
      landmark: o.landmark,
      lat: o.lat,
      lng: o.lng,
    },
    subtotal: o.subtotal,
    discountTotal: o.discountTotal,
    discounts: (o.discounts as DiscountLine[] | null) ?? [],
    giftNote: o.giftNote,
    creditUsed: o.creditUsed,
    deliveryFee: o.deliveryFee,
    total: o.total,
    amountDue: o.amountDue,
    amountPaid: o.amountPaid,
    balance: Math.max(0, o.total - o.amountPaid),
    isDeposit: o.isDeposit,
    payment: {
      methodId: o.paymentMethodId,
      label: o.paymentLabel,
      transactionRef: o.transactionRef,
      proofUrl: o.paymentProofKey ? imageUrls(o.paymentProofKey).lg : null,
    },
    note: o.note,
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      variantId: i.variantId,
      name: i.productName,
      size: i.size,
      color: i.color,
      image: i.imageKey ? imageUrls(i.imageKey).sm : null,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      ...(opts.staff ? { costPrice: i.costPrice } : {}),
    })),
    ...(opts.staff ? { costTotal: o.costTotal, profit: o.total - (o.deliveryFee ?? 0) - o.costTotal, paymentCheck: o.paymentCheck } : {}),
    events: o.events
      ?.filter((e) => opts.staff || !e.type.startsWith('internal'))
      .map((e) => ({ id: e.id, type: e.type, message: e.message, createdAt: e.createdAt })),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}


// ─── Helpers ─────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newOrderNumber(): string {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  let rand = '';
  for (let i = 0; i < 5; i++) rand += ALPHABET[randomInt(ALPHABET.length)];
  return `HM-${yymm}-${rand}`;
}

export const orderInclude = { items: true, events: { orderBy: { createdAt: 'asc' } } } as const;

// ─── Create ──────────────────────────────────────────────

export interface CreateOrderInput {
  items: { variantId: string; quantity: number }[];
  customerName: string;
  customerPhone: string;
  deliveryOptionId: string;
  city?: string;
  area?: string;
  landmark?: string;
  lat?: number;
  lng?: number;
  paymentMethodId: string;
  payDeposit: boolean;
  note?: string;
  source: OrderSource;
  /** promo code (or a typed invite code) */
  code?: string;
  /** invite code from a friend's link */
  invite?: string;
  /** pay part with Hikma credit */
  useCredit?: boolean;
}

export async function createOrder(user: User | null, input: CreateOrderInput, actorId?: string) {
  // Merge duplicate lines
  const qty = new Map<string, number>();
  for (const it of input.items) qty.set(it.variantId, (qty.get(it.variantId) ?? 0) + it.quantity);

  const [settings, delivery, payment, variants] = await Promise.all([
    getSettings(),
    prisma.deliveryOption.findFirst({ where: { id: input.deliveryOptionId, isEnabled: true } }),
    prisma.paymentMethod.findFirst({ where: { id: input.paymentMethodId, isEnabled: true } }),
    prisma.productVariant.findMany({
      where: { id: { in: [...qty.keys()] } },
      include: { product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 }, category: { select: { slug: true } } } } },
    }),
  ]);

  if (!delivery) throw badRequest('Choose a delivery option', 'DELIVERY');
  if (!payment) throw badRequest('Choose a payment method', 'PAYMENT');
  if (delivery.needsAddress && !input.area && !input.landmark && input.lat === undefined) {
    throw badRequest('Add your delivery address', 'ADDRESS');
  }
  if (variants.length !== qty.size) throw conflict('Some items are no longer available', 'UNAVAILABLE');

  let subtotal = 0;
  let costTotal = 0;
  const lines = variants.map((v) => {
    if (!v.isActive || v.product.status !== 'ACTIVE') throw conflict(`${v.product.nameEn} is no longer available`, 'UNAVAILABLE');
    const quantity = qty.get(v.id)!;
    const unitPrice = v.price ?? v.product.basePrice;
    const costPrice = v.product.costPrice ?? 0;
    subtotal += unitPrice * quantity;
    costTotal += costPrice * quantity;
    return {
      variantId: v.id,
      productId: v.productId,
      productName: v.product.nameEn,
      size: v.size,
      color: v.color,
      imageKey: v.product.images[0]?.key ?? null,
      unitPrice,
      costPrice,
      quantity,
    };
  });

  // Discounts: bundles, one promotion, credit — the same calculation as the checkout quote
  const priced = await quote(
    variants.map((v) => ({ variantId: v.id, productId: v.productId, categorySlug: v.product.category.slug, unitPrice: v.price ?? v.product.basePrice, quantity: qty.get(v.id)! })),
    { user, code: input.code, invite: input.invite, useCredit: input.useCredit },
  );
  if (input.code && !priced.codeApplied && priced.codeError && priced.codeError !== 'A better offer is already applied') {
    throw badRequest(priced.codeError, 'CODE');
  }

  const deliveryFee = delivery.fee;
  const total = priced.itemsTotal + (deliveryFee ?? 0);
  const isDeposit = Boolean(input.payDeposit && settings.partialPaymentEnabled && payment.id !== 'cash');
  const amountDue = isDeposit ? Math.ceil((total * settings.depositPercent) / 100) : total;

  const order = await prisma.$transaction(async (tx) => {
    // Conditional decrement: fails if someone else bought the last piece first.
    for (const line of lines) {
      const updated = await tx.productVariant.updateMany({
        where: { id: line.variantId, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } },
      });
      if (updated.count === 0) {
        const sizeColor = [line.size, line.color].filter(Boolean).join(' / ');
        throw conflict(`${line.productName}${sizeColor ? ` (${sizeColor})` : ''} is out of stock`, 'OUT_OF_STOCK');
      }
    }

    // A limited promotion is counted in the same transaction, so it can't be used past its limit
    if (priced.promotion) {
      const p = await tx.promotion.findUniqueOrThrow({ where: { id: priced.promotion.id } });
      const used = await tx.promotion.updateMany({
        where: { id: p.id, ...(p.maxUses !== null ? { usedCount: { lt: p.maxUses } } : {}) },
        data: { usedCount: { increment: 1 } },
      });
      if (!used.count) throw conflict('This offer has just run out — please try again', 'PROMO_ENDED');
    }
    // Credit: lock this customer's ledger so two orders can't spend the same credit
    if (priced.creditUsed > 0 && user) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
      if ((await creditBalance(user.id, tx)) < priced.creditUsed) throw conflict('Your credit changed — please review your order', 'CREDIT');
    }

    const created = await tx.order.create({
      data: {
        orderNumber: newOrderNumber(),
        userId: user?.id ?? null,
        source: input.source,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        telegramChatId: user?.telegramId ?? null,
        deliveryOptionId: delivery.id,
        deliveryLabel: delivery.nameEn,
        city: input.city,
        area: input.area,
        landmark: input.landmark,
        lat: input.lat,
        lng: input.lng,
        subtotal,
        discountTotal: priced.discountTotal,
        discounts: priced.discounts as unknown as Prisma.InputJsonValue,
        giftNote: priced.giftNote,
        promotionId: priced.promotion?.id ?? null,
        creditUsed: priced.creditUsed,
        referrerId: priced.referrerId,
        deliveryFee,
        total,
        costTotal,
        amountDue,
        isDeposit,
        paymentMethodId: payment.id,
        paymentLabel: payment.name,
        note: input.note,
        items: { create: lines },
        events: { create: { type: 'placed', message: 'Order placed', actorId: actorId ?? user?.id ?? null } },
      },
      include: orderInclude,
    });

    await tx.stockMovement.createMany({
      data: lines.map((l) => ({ variantId: l.variantId, delta: -l.quantity, reason: 'ORDER' as const, orderId: created.id, actorId })),
    });
    if (priced.creditUsed > 0 && user) {
      await tx.creditEntry.create({ data: { userId: user.id, amount: -priced.creditUsed, reason: 'redeem', orderId: created.id, note: created.orderNumber } });
    }
    return created;
  });

  // Remember contact + address for next checkout. Outside the transaction: a failure here
  // (e.g. phone already used by another account) must not undo the order.
  if (user?.role === 'CUSTOMER') {
    // Remember the size bought per category, so it's pre-selected next time
    const sizes = Object.fromEntries(variants.filter((v) => v.size).map((v) => [v.product.category.slug, v.size]));
    const data = {
      city: input.city ?? user.city,
      area: input.area ?? user.area,
      landmark: input.landmark ?? user.landmark,
      ...(Object.keys(sizes).length ? { sizeProfile: mergeSizeProfile(user.sizeProfile, { sizes }) } : {}),
    };
    await prisma.user
      .update({ where: { id: user.id }, data: { ...data, ...(user.phone ? {} : { phone: input.customerPhone }) } })
      .catch(() => prisma.user.update({ where: { id: user.id }, data }).catch(() => undefined));
  }

  // Remember who invited this customer (first time only) and tell the inviter a reward is on the way
  if (user && priced.referrerId) {
    if (!user.referredById) void prisma.user.updateMany({ where: { id: user.id, referredById: null }, data: { referredById: priced.referrerId } }).catch(() => undefined);
    safely(() => onOrderPlaced(order.id), 'invite notice');
  }
  // The bag became an order: no 'you left something in your bag' reminder
  if (user) void prisma.cartSnapshot.deleteMany({ where: { userId: user.id } }).catch(() => undefined);

  notifyOrderEvent(order.id, 'placed');
  return order;
}

// Lifecycle rules live in ./rules (shared with the Telegram cards)

// ─── Payment ─────────────────────────────────────────────

/** Another active order already used this transaction number? (Same receipt sent twice = fraud risk.) */
async function findDuplicateReference(orderId: string, ref: string) {
  return prisma.order.findFirst({
    where: { id: { not: orderId }, transactionRef: { equals: ref, mode: 'insensitive' }, status: { not: 'CANCELLED' } },
    select: { orderNumber: true },
  });
}

export async function submitPayment(orderId: string, input: { transactionRef?: string; proofKey?: string }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order not found');
  if (order.status === 'CANCELLED') throw conflict('This order was cancelled', 'CANCELLED');
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') throw conflict('Payment already confirmed', 'ALREADY_PAID');
  if (!input.transactionRef && !input.proofKey) throw badRequest('Add the transaction number or a screenshot', 'PROOF');

  let paymentStatus: 'SUBMITTED' | 'PAID' | 'PARTIAL' = 'SUBMITTED';
  let amountPaid = order.amountPaid;
  let status: OrderStatus = order.status;
  let message = 'Payment proof submitted';
  let paymentCheck: string | null = null;

  const ref = input.transactionRef?.trim().toUpperCase();
  const duplicate = ref ? await findDuplicateReference(orderId, ref) : null;

  if (duplicate) {
    // Never auto-approve a reused receipt; staff decide
    paymentCheck = `⚠️ This transaction number was already used on ${duplicate.orderNumber}`;
  } else if (ref) {
    const settings = await getSettings();
    if (canAutoVerify(settings, order.paymentMethodId)) {
      const result = await verifyTransaction({
        apiKey: settings.paymentVerifyKey,
        paymentMethodId: order.paymentMethodId!,
        transactionRef: ref,
        amount: order.amountDue,
        merchantName: settings.storeName,
      });
      if (result.verified) {
        amountPaid = Math.min(order.total, result.amount ?? order.amountDue);
        paymentStatus = amountPaid >= order.total ? 'PAID' : 'PARTIAL';
        status = order.status === 'PENDING' ? 'CONFIRMED' : order.status;
        message = 'Payment verified automatically';
        paymentCheck = `🤖 Verified automatically (${amountPaid.toLocaleString('en-US')} ETB)`;
      } else {
        paymentCheck = `🤖 Not verified automatically${result.message ? `: ${result.message}` : ''} — please check by hand`;
      }
    }
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      transactionRef: ref ?? order.transactionRef,
      paymentProofKey: input.proofKey ?? order.paymentProofKey,
      paymentStatus,
      amountPaid,
      status,
      paymentCheck,
      events: {
        create: [
          { type: paymentStatus === 'SUBMITTED' ? 'payment_submitted' : 'payment_verified', message },
          ...(paymentCheck ? [{ type: 'internal_payment_check', message: paymentCheck }] : []),
        ],
      },
    },
    include: orderInclude,
  });
  notifyOrderEvent(updated.id, paymentStatus === 'SUBMITTED' ? 'payment_submitted' : 'payment_verified');
  return updated;
}

/** Staff confirms (or rejects) a payment. */
export async function reviewPayment(orderId: string, actorId: string | null, input: { approve: boolean; amountPaid?: number; reason?: string }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order not found');
  if (order.status === 'CANCELLED') throw conflict('This order was cancelled', 'STALE');
  if (order.paymentStatus === 'PAID') throw conflict('Payment is already confirmed', 'STALE');

  if (!input.approve) {
    if (order.paymentStatus === 'PARTIAL') throw conflict('A deposit was already confirmed — cancel the order instead', 'STALE');
    const res = await prisma.order.updateMany({
      where: { id: orderId, paymentStatus: order.paymentStatus },
      data: { paymentStatus: 'REJECTED' },
    });
    if (res.count === 0) throw conflict('This order was just updated by someone else', 'STALE');
    await prisma.orderEvent.create({
      data: { orderId, type: 'payment_rejected', message: input.reason || 'Payment could not be confirmed', actorId },
    });
    notifyOrderEvent(orderId, 'payment_rejected');
    return prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  }

  const amountPaid = Math.min(order.total, input.amountPaid ?? Math.max(order.amountDue, order.amountPaid));
  if (amountPaid <= order.amountPaid && order.paymentStatus === 'PARTIAL') throw conflict('This deposit is already confirmed', 'STALE');
  const paymentStatus = amountPaid >= order.total ? 'PAID' : 'PARTIAL';
  // Conditional update: if two people act at once, only the first one wins
  const res = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: order.paymentStatus, status: order.status },
    data: { amountPaid, paymentStatus, status: order.status === 'PENDING' ? 'CONFIRMED' : order.status },
  });
  if (res.count === 0) throw conflict('This order was just updated by someone else', 'STALE');
  await prisma.orderEvent.create({
    data: {
      orderId,
      type: 'payment_verified',
      message: paymentStatus === 'PAID' ? 'Payment confirmed' : `Deposit of ${amountPaid.toLocaleString('en-US')} ETB confirmed`,
      actorId,
    },
  });
  notifyOrderEvent(orderId, 'payment_verified');
  return prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
}

// ─── Status ──────────────────────────────────────────────

const STATUS_MESSAGES: Record<OrderStatus, string> = {
  PENDING: 'Order pending',
  CONFIRMED: 'Order confirmed',
  PACKING: 'Being prepared',
  OUT_FOR_DELIVERY: 'On the way',
  DELIVERED: 'Delivered',
  PICKED_UP: 'Picked up at the shop',
  CANCELLED: 'Order cancelled',
};

export async function changeStatus(orderId: string, status: OrderStatus, actorId: string | null, note?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw notFound('Order not found');
  if (order.status === status) throw conflict(`This order is already ${STATUS_LABEL[status]}`, 'STALE');
  if (!canMoveTo(order.status, status)) {
    throw conflict(
      isFinalStatus(order.status)
        ? `This order is already ${STATUS_LABEL[order.status]} — it can’t be changed`
        : `This order is already ${STATUS_LABEL[order.status]} — it can’t go back to ${STATUS_LABEL[status]}`,
      'STALE',
    );
  }

  const delivered = status === 'DELIVERED' || status === 'PICKED_UP';
  const updated = await prisma.$transaction(async (tx) => {
    // Conditional on the status we read: two simultaneous clicks can't both apply
    const res = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      // Balance is collected on delivery / at pickup
      data: { status, ...(delivered ? { amountPaid: order.total, paymentStatus: 'PAID' } : {}) },
    });
    if (res.count === 0) throw conflict('This order was just updated by someone else', 'STALE');
    if (status === 'CANCELLED') {
      for (const item of order.items) {
        await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
      }
      await tx.stockMovement.createMany({
        data: order.items.map((i) => ({ variantId: i.variantId, delta: i.quantity, reason: 'CANCEL' as const, orderId, actorId })),
      });
    }
    await tx.orderEvent.create({
      data: { orderId, type: `status_${status.toLowerCase()}`, message: note || STATUS_MESSAGES[status], actorId },
    });
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  });
  notifyOrderEvent(orderId, 'status');
  if (status === 'CANCELLED') {
    onStockRestored(order.items.map((i) => i.variantId));
    safely(() => onOrderCancelled(orderId), 'credit refund');
  }
  if (delivered) safely(() => onOrderReceived(orderId), 'rewards');
  return updated;
}

/** Releases stock held by unpaid orders older than `hours`. */
export async function cancelStaleUnpaidOrders(hours = 48) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING', paymentStatus: { in: ['UNPAID', 'REJECTED'] }, paymentMethodId: { not: 'cash' }, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  });
  for (const o of stale) {
    await changeStatus(o.id, 'CANCELLED', null, 'Cancelled automatically — no payment received').catch(() => undefined);
  }
  return stale.length;
}

export type OrderWhere = Prisma.OrderWhereInput;

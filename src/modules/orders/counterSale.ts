/**
 * Shop counter: walk-in sales entered by staff on their phone. The sale is recorded as an order
 * (source COUNTER) that is already paid and handed over, and stock goes down in the same
 * transaction — so the website can never sell the piece that just left the shop.
 */
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http';
import { onStockRestored } from '../alerts/backInStock';
import { newOrderNumber, orderInclude } from './orders.service';

export interface CounterSaleInput {
  items: { variantId: string; quantity: number; unitPrice?: number }[];
  paymentMethodId: string;
  customerName?: string;
  customerPhone?: string;
  note?: string;
}

/** A counter sale can be undone for this long (a mistake at the till), after that it's history. */
export const UNDO_HOURS = 24;

export async function createCounterSale(input: CounterSaleInput, actorId: string) {
  const qty = new Map<string, { quantity: number; unitPrice?: number }>();
  for (const it of input.items) {
    const prev = qty.get(it.variantId);
    qty.set(it.variantId, { quantity: (prev?.quantity ?? 0) + it.quantity, unitPrice: it.unitPrice ?? prev?.unitPrice });
  }

  const [payment, actor, variants] = await Promise.all([
    prisma.paymentMethod.findUnique({ where: { id: input.paymentMethodId } }),
    prisma.user.findUnique({ where: { id: actorId }, select: { fullName: true } }),
    prisma.productVariant.findMany({
      where: { id: { in: [...qty.keys()] } },
      include: { product: { include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } } },
    }),
  ]);
  if (!payment) throw badRequest('Choose how the customer paid', 'PAYMENT');
  if (variants.length !== qty.size) throw conflict('Some items no longer exist', 'UNAVAILABLE');

  let subtotal = 0;
  let costTotal = 0;
  const lines = variants.map((v) => {
    if (!v.isActive || v.product.status === 'ARCHIVED') throw conflict(`${v.product.nameEn} is no longer sold`, 'UNAVAILABLE');
    const { quantity, unitPrice: agreed } = qty.get(v.id)!;
    const unitPrice = agreed ?? v.price ?? v.product.basePrice; // staff may give a discount at the counter
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

  const seller = actor?.fullName ?? 'staff';
  return prisma.$transaction(async (tx) => {
    for (const line of lines) {
      const updated = await tx.productVariant.updateMany({
        where: { id: line.variantId, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } },
      });
      if (updated.count === 0) {
        const detail = [line.size, line.color].filter(Boolean).join(' / ');
        throw conflict(`${line.productName}${detail ? ` (${detail})` : ''}: not enough in stock — check the count`, 'OUT_OF_STOCK');
      }
    }
    const order = await tx.order.create({
      data: {
        orderNumber: newOrderNumber(),
        source: 'COUNTER',
        customerName: input.customerName?.trim() || 'Walk-in customer',
        customerPhone: input.customerPhone?.trim() || '',
        deliveryOptionId: 'pickup',
        deliveryLabel: 'Sold in the shop',
        subtotal,
        deliveryFee: 0,
        total: subtotal,
        costTotal,
        amountDue: subtotal,
        amountPaid: subtotal,
        paymentMethodId: payment.id,
        paymentLabel: payment.id === 'cash' ? 'Cash' : payment.name,
        paymentStatus: 'PAID',
        status: 'PICKED_UP',
        note: input.note,
        items: { create: lines },
        events: { create: { type: 'counter_sale', message: `Sold in the shop by ${seller}`, actorId } },
      },
      include: orderInclude,
    });
    await tx.stockMovement.createMany({
      data: lines.map((l) => ({ variantId: l.variantId, delta: -l.quantity, reason: 'ORDER' as const, orderId: order.id, actorId })),
    });
    return order;
  });
}

/** Undo a counter sale entered by mistake: the pieces go back on sale. */
export async function undoCounterSale(orderId: string, actorId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.source !== 'COUNTER') throw notFound('Shop sale not found');
  if (order.status === 'CANCELLED') throw conflict('This sale was already undone', 'STALE');
  if (Date.now() - order.createdAt.getTime() > UNDO_HOURS * 3600_000) {
    throw conflict(`Shop sales can only be undone within ${UNDO_HOURS} hours`, 'TOO_LATE');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data: { status: 'CANCELLED' } });
    if (!res.count) throw conflict('This sale was just changed by someone else', 'STALE');
    for (const item of order.items) {
      await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
    }
    await tx.stockMovement.createMany({
      data: order.items.map((i) => ({ variantId: i.variantId, delta: i.quantity, reason: 'CANCEL' as const, orderId, actorId })),
    });
    await tx.orderEvent.create({ data: { orderId, type: 'status_cancelled', message: 'Shop sale undone — items back in stock', actorId } });
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  });
  onStockRestored(order.items.map((i) => i.variantId));
  return updated;
}

/** Today's counter sales (Addis day) for the counter screen. */
export async function counterSalesSince(since: Date) {
  return prisma.order.findMany({
    where: { source: 'COUNTER', createdAt: { gte: since } },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

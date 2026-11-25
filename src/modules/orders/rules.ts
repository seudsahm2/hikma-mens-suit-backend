import type { OrderStatus, PaymentStatus } from '@prisma/client';

/**
 * Order lifecycle rules — the single source of truth for every caller (dashboard, Telegram buttons,
 * automation) and for which buttons the Telegram cards show.
 *
 *   PENDING → CONFIRMED → PACKING → OUT_FOR_DELIVERY → DELIVERED     (or PICKED_UP for shop pickup)
 *   any unfinished state → CANCELLED
 *   DELIVERED / PICKED_UP / CANCELLED are final.
 */
const STEP: Record<OrderStatus, number> = {
  PENDING: 0,
  CONFIRMED: 1,
  PACKING: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
  PICKED_UP: 4,
  CANCELLED: 9,
};
const FINAL: OrderStatus[] = ['DELIVERED', 'PICKED_UP', 'CANCELLED'];

export const isFinalStatus = (s: OrderStatus) => FINAL.includes(s);

/** Forward steps only, or cancel while not finished. */
export function canMoveTo(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to || isFinalStatus(from)) return false;
  if (to === 'CANCELLED') return true;
  return STEP[to] > STEP[from];
}

/**
 * The finishing step must match how the order is received: a delivery order ends DELIVERED
 * (confirmed with the customer's code), a shop-pickup order ends PICKED_UP. Without this, a delivery
 * order could be closed as "picked up" and skip the delivery code entirely.
 */
export function fitsDeliveryType(to: OrderStatus, pickup: boolean): boolean {
  if (to === 'PICKED_UP') return pickup;
  if (to === 'DELIVERED' || to === 'OUT_FOR_DELIVERY') return !pickup;
  return true;
}

/** Staff can still confirm (or reject) the payment. */
export function canReviewPayment(status: OrderStatus, payment: PaymentStatus) {
  return !isFinalStatus(status) && (payment === 'UNPAID' || payment === 'SUBMITTED' || payment === 'REJECTED');
}

/** The next delivery steps worth offering as buttons, in order. */
export function nextSteps(status: OrderStatus, pickup: boolean): OrderStatus[] {
  const candidates: OrderStatus[] = pickup ? ['PACKING', 'PICKED_UP'] : ['PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  return candidates.filter((s) => canMoveTo(status, s));
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PACKING: 'being packed',
  OUT_FOR_DELIVERY: 'on the way',
  DELIVERED: 'delivered',
  PICKED_UP: 'picked up',
  CANCELLED: 'cancelled',
};

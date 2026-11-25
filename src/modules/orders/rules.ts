import type { OrderStatus, PaymentStatus } from '@prisma/client';

/**
 * Order lifecycle rules — the single source of truth for every caller (dashboard, Telegram buttons,
 * automation) and for which buttons the Telegram cards show.
 *
 *   PENDING → CONFIRMED → PACKING → OUT_FOR_DELIVERY → DELIVERED     (or PICKED_UP for shop pickup)
 *   any unfinished state → CANCELLED
 *   DELIVERED / PICKED_UP / CANCELLED are final.
 */
/**
 * One step at a time — the same flow on the website, the Mini App and the Telegram cards:
 *   delivery: PENDING → CONFIRMED → PACKING → OUT_FOR_DELIVERY (driver handover) → DELIVERED (customer's code)
 *   pickup:   PENDING → CONFIRMED → PACKING → PICKED_UP
 * (Confirming the payment moves PENDING → CONFIRMED by itself.)
 */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED'],
  CONFIRMED: ['PACKING'],
  PACKING: ['OUT_FOR_DELIVERY', 'PICKED_UP'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  PICKED_UP: [],
  CANCELLED: [],
};
const FINAL: OrderStatus[] = ['DELIVERED', 'PICKED_UP', 'CANCELLED'];

export const isFinalStatus = (s: OrderStatus) => FINAL.includes(s);

/** The next step only (no skipping), or cancel while not finished. */
export function canMoveTo(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to || isFinalStatus(from)) return false;
  if (to === 'CANCELLED') return true;
  return NEXT[from].includes(to);
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
  return NEXT[status].filter((s) => fitsDeliveryType(s, pickup));
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

import { describe, expect, it } from 'vitest';
import { canMoveTo, canReviewPayment, isFinalStatus, nextSteps } from '../src/modules/orders/rules';

describe('order lifecycle rules', () => {
  it('only moves forward', () => {
    expect(canMoveTo('PENDING', 'CONFIRMED')).toBe(true);
    expect(canMoveTo('CONFIRMED', 'OUT_FOR_DELIVERY')).toBe(true); // skipping a step is fine
    expect(canMoveTo('OUT_FOR_DELIVERY', 'PACKING')).toBe(false); // never backwards
    expect(canMoveTo('PACKING', 'PACKING')).toBe(false);
  });

  it('locks finished and cancelled orders', () => {
    for (const s of ['DELIVERED', 'PICKED_UP', 'CANCELLED'] as const) {
      expect(isFinalStatus(s)).toBe(true);
      expect(canMoveTo(s, 'CANCELLED')).toBe(false);
      expect(canMoveTo(s, 'PACKING')).toBe(false);
    }
  });

  it('allows cancelling anything unfinished', () => {
    for (const s of ['PENDING', 'CONFIRMED', 'PACKING', 'OUT_FOR_DELIVERY'] as const) expect(canMoveTo(s, 'CANCELLED')).toBe(true);
  });

  it('offers payment buttons only while the payment is open', () => {
    expect(canReviewPayment('PENDING', 'SUBMITTED')).toBe(true);
    expect(canReviewPayment('CONFIRMED', 'PAID')).toBe(false);
    expect(canReviewPayment('DELIVERED', 'SUBMITTED')).toBe(false); // the bug from the field: stale "Payment OK"
    expect(canReviewPayment('CANCELLED', 'UNPAID')).toBe(false);
  });

  it('suggests the right next buttons', () => {
    expect(nextSteps('PENDING', false)).toEqual(['PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(nextSteps('OUT_FOR_DELIVERY', false)).toEqual(['DELIVERED']);
    expect(nextSteps('PACKING', true)).toEqual(['PICKED_UP']);
    expect(nextSteps('DELIVERED', false)).toEqual([]);
  });
});

describe('finishing step matches the delivery type', () => {
  it('a delivery order can never be closed as "picked up"', async () => {
    const { fitsDeliveryType } = await import('../src/modules/orders/rules');
    expect(fitsDeliveryType('PICKED_UP', false)).toBe(false);
    expect(fitsDeliveryType('DELIVERED', false)).toBe(true);
    expect(fitsDeliveryType('OUT_FOR_DELIVERY', false)).toBe(true);
  });
  it('a shop-pickup order can never be "delivered" or "on the way"', async () => {
    const { fitsDeliveryType } = await import('../src/modules/orders/rules');
    expect(fitsDeliveryType('DELIVERED', true)).toBe(false);
    expect(fitsDeliveryType('OUT_FOR_DELIVERY', true)).toBe(false);
    expect(fitsDeliveryType('PICKED_UP', true)).toBe(true);
  });
  it('other steps are fine for both', async () => {
    const { fitsDeliveryType } = await import('../src/modules/orders/rules');
    for (const s of ['CONFIRMED', 'PACKING', 'CANCELLED'] as const) {
      expect(fitsDeliveryType(s, true)).toBe(true);
      expect(fitsDeliveryType(s, false)).toBe(true);
    }
  });
});

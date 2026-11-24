import type { Settings } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * Automatic payment checking through ShegerPay (Ethiopian receipt verification).
 * OFF by default — payments are confirmed by staff. The owner turns it on in Settings and pastes the
 * API key of HER ShegerPay account (it checks that money reached her accounts).
 */

/** Payment method ids (ours) → ShegerPay provider codes. Methods not listed are always checked by hand. */
export const AUTO_VERIFY_PROVIDERS: Record<string, string> = {
  telebirr: 'telebirr',
  cbe: 'cbe',
  cbe_birr: 'cbe',
  boa: 'boa',
  awash: 'awash',
  dashen: 'dashen',
  coop: 'coop',
  hibret: 'hibret',
  mpesa: 'mpesa',
};

export interface VerifyResult {
  verified: boolean;
  amount?: number;
  message?: string;
}

export const verificationKey = (settings: Pick<Settings, 'paymentVerifyKey'>) => settings.paymentVerifyKey || env.SHEGERPAY_API_KEY || null;

/** True only when the owner switched it on, a key exists, and the method is supported. */
export function canAutoVerify(settings: Pick<Settings, 'autoVerifyPayments' | 'paymentVerifyKey'>, paymentMethodId: string | null | undefined): boolean {
  return Boolean(settings.autoVerifyPayments && verificationKey(settings) && paymentMethodId && AUTO_VERIFY_PROVIDERS[paymentMethodId]);
}

/**
 * Asks ShegerPay whether a transaction reference is a real payment of `amount` to the merchant.
 * Returns verified=false on any error so the order falls back to manual review.
 */
export async function verifyTransaction(params: {
  apiKey: string | null;
  paymentMethodId: string;
  transactionRef: string;
  amount: number;
  merchantName: string;
}): Promise<VerifyResult> {
  const key = params.apiKey || env.SHEGERPAY_API_KEY;
  const provider = AUTO_VERIFY_PROVIDERS[params.paymentMethodId];
  if (!key || !provider) return { verified: false, message: 'automatic checking unavailable for this method' };

  try {
    const res = await fetch(`${env.SHEGERPAY_BASE_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        provider,
        transaction_id: params.transactionRef.trim().toUpperCase(),
        amount: params.amount,
        merchant_name: params.merchantName,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      verified?: boolean;
      valid?: boolean;
      status?: string;
      amount_verified?: number;
      message?: string;
      reason?: string;
      error?: string;
    };
    if (res.status === 401 || res.status === 403) return { verified: false, message: 'the ShegerPay key was rejected' };
    const verified = (json.verified === true || json.valid === true) && json.status === 'verified';
    return {
      verified,
      amount: verified ? (json.amount_verified ?? params.amount) : undefined,
      message: (json.message ?? json.reason ?? json.error)?.slice(0, 160),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ShegerPay verification failed');
    return { verified: false, message: 'verification service unreachable' };
  }
}

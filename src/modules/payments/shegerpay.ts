import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/** Payment method ids (ours) → ShegerPay provider codes. Methods not listed can't be auto-verified. */
const PROVIDERS: Record<string, string> = {
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

export function canAutoVerify(paymentMethodId: string | null | undefined): boolean {
  return Boolean(env.SHEGERPAY_API_KEY && paymentMethodId && PROVIDERS[paymentMethodId]);
}

/**
 * Asks ShegerPay whether a transaction reference is a real payment of `amount` to the merchant.
 * Returns verified=false on any error so the order falls back to manual review.
 */
export async function verifyTransaction(params: {
  paymentMethodId: string;
  transactionRef: string;
  amount: number;
  merchantName: string;
}): Promise<VerifyResult> {
  const provider = PROVIDERS[params.paymentMethodId];
  if (!env.SHEGERPAY_API_KEY || !provider) return { verified: false, message: 'Auto-verification unavailable' };

  try {
    const res = await fetch(`${env.SHEGERPAY_BASE_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.SHEGERPAY_API_KEY },
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
    };
    const verified = (json.verified === true || json.valid === true) && json.status === 'verified';
    return {
      verified,
      amount: verified ? (json.amount_verified ?? params.amount) : undefined,
      message: json.message ?? json.reason,
    };
  } catch (err) {
    logger.warn({ err }, 'ShegerPay verification failed');
    return { verified: false, message: 'Verification service unreachable' };
  }
}

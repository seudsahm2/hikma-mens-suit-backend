import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramIdentity {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  languageCode?: string;
}

const MAX_AGE_SECONDS = 24 * 60 * 60;

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function isFresh(authDate: number, nowSeconds: number): boolean {
  return Number.isFinite(authDate) && nowSeconds - authDate <= MAX_AGE_SECONDS && authDate - nowSeconds < 300;
}

/**
 * Validates Telegram Mini App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyMiniAppInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramIdentity | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, hash)) return null;
  if (!isFresh(Number(params.get('auth_date')), nowSeconds)) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;
  try {
    const u = JSON.parse(rawUser) as {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
      language_code?: string;
    };
    return {
      id: u.id,
      firstName: u.first_name,
      lastName: u.last_name,
      username: u.username,
      photoUrl: u.photo_url,
      languageCode: u.language_code,
    };
  } catch {
    return null;
  }
}

export interface LoginWidgetPayload {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Validates data from the Telegram Login Widget (website sign-in).
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyLoginWidget(
  payload: LoginWidgetPayload,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramIdentity | null {
  const { hash, ...fields } = payload;
  const dataCheckString = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, hash)) return null;
  if (!isFresh(Number(payload.auth_date), nowSeconds)) return null;

  return {
    id: payload.id,
    firstName: payload.first_name,
    lastName: payload.last_name,
    username: payload.username,
    photoUrl: payload.photo_url,
  };
}

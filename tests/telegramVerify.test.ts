import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLoginWidget, verifyMiniAppInitData } from '../src/modules/auth/telegramVerify';

const TOKEN = '123456:TEST-token';
const NOW = 1_800_000_000;

function signInitData(fields: Record<string, string>, token = TOKEN) {
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 42, first_name: 'Abel', username: 'abel', language_code: 'am' });

describe('verifyMiniAppInitData', () => {
  it('accepts correctly signed, fresh data', () => {
    const initData = signInitData({ auth_date: String(NOW - 60), query_id: 'AAH', user });
    expect(verifyMiniAppInitData(initData, TOKEN, NOW)).toMatchObject({ id: 42, firstName: 'Abel', languageCode: 'am' });
  });

  it('rejects a tampered user', () => {
    const initData = signInitData({ auth_date: String(NOW), user }).replace('Abel', 'Eve');
    expect(verifyMiniAppInitData(initData, TOKEN, NOW)).toBeNull();
  });

  it('rejects data signed with another bot token', () => {
    expect(verifyMiniAppInitData(signInitData({ auth_date: String(NOW), user }, '999:other'), TOKEN, NOW)).toBeNull();
  });

  it('rejects data older than 24 hours', () => {
    expect(verifyMiniAppInitData(signInitData({ auth_date: String(NOW - 90_000), user }), TOKEN, NOW)).toBeNull();
  });

  it('rejects missing hash', () => {
    expect(verifyMiniAppInitData(`auth_date=${NOW}&user=${encodeURIComponent(user)}`, TOKEN, NOW)).toBeNull();
  });
});

describe('verifyLoginWidget', () => {
  function signWidget(fields: Record<string, string | number>) {
    const dcs = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = createHash('sha256').update(TOKEN).digest();
    return createHmac('sha256', secret).update(dcs).digest('hex');
  }

  it('accepts a valid payload', () => {
    const fields = { id: 7, first_name: 'Sami', username: 'sami', auth_date: NOW };
    expect(verifyLoginWidget({ ...fields, hash: signWidget(fields) }, TOKEN, NOW)).toMatchObject({ id: 7, username: 'sami' });
  });

  it('rejects a modified id', () => {
    const fields = { id: 7, first_name: 'Sami', auth_date: NOW };
    expect(verifyLoginWidget({ ...fields, id: 8, hash: signWidget(fields) }, TOKEN, NOW)).toBeNull();
  });
});

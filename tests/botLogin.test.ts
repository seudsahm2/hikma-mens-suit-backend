import { describe, expect, it } from 'vitest';
import { checkLoginToken, confirmLoginToken, createLoginToken } from '../src/modules/auth/botLogin';

const who = { id: 42, firstName: 'Abel', username: 'abel' };

describe('bot login tokens', () => {
  it('uses only characters Telegram allows in a start parameter', () => {
    const t = createLoginToken();
    expect(`login_${t}`).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('is pending until the bot confirms it, then works exactly once', () => {
    const t = createLoginToken();
    expect(checkLoginToken(t)).toEqual({ status: 'pending' });
    expect(confirmLoginToken(t, who)).toBe(true);
    expect(checkLoginToken(t)).toEqual({ status: 'confirmed', identity: who });
    expect(checkLoginToken(t)).toEqual({ status: 'expired' });
  });

  it('rejects unknown tokens', () => {
    expect(confirmLoginToken('nope', who)).toBe(false);
    expect(checkLoginToken('nope')).toEqual({ status: 'expired' });
  });
});

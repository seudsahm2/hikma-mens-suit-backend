import { describe, expect, it } from 'vitest';
import { hashLoginToken, isWellFormedToken, newLoginToken } from '../src/modules/auth/botLogin';

// Database behaviour (create → confirm → consume once) is covered by the integration check in
// docs/README; these tests cover the pure parts that must never change silently.
describe('bot login tokens', () => {
  it('fits Telegram start-parameter rules (alphabet and 64-char limit including "login_")', () => {
    for (let i = 0; i < 50; i++) {
      const t = newLoginToken();
      expect(isWellFormedToken(t)).toBe(true);
      expect(`login_${t}`).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('stores only a hash, never the token itself', () => {
    const t = newLoginToken();
    const h = hashLoginToken(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(t);
    expect(hashLoginToken(t)).toBe(h);
  });

  it('rejects malformed tokens before touching the database', () => {
    expect(isWellFormedToken('nope')).toBe(false);
    expect(isWellFormedToken('a'.repeat(33))).toBe(false);
    expect(isWellFormedToken('../../etc/passwd________________')).toBe(false);
  });
});

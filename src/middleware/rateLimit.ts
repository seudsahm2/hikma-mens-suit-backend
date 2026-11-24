import type { Request } from 'express';
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';

/**
 * The visitor's real IP. On Render, requests pass through Cloudflare and Render's proxy, so req.ip can be a
 * shared proxy address — which would make every customer share one rate-limit bucket.
 * Cloudflare's CF-Connecting-IP is set by Cloudflare itself and can't be forged by the client.
 */
export function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const trueClient = req.headers['true-client-ip'];
  if (typeof trueClient === 'string' && trueClient) return trueClient.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Rate limiter keyed by the real client IP (IPv6 grouped per /56 as recommended). */
export function limiter(opts: Partial<Options> & { windowMs: number; limit: number }) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req as Request)),
    message: { error: { message: 'Too many attempts. Please wait a minute and try again.', code: 'RATE_LIMITED' } },
    ...opts,
  });
}

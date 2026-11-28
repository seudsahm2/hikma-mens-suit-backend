import { Router } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { limiter } from '../../middleware/rateLimit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { signToken } from '../../lib/auth';
import { ah, badRequest, HttpError, unauthorized } from '../../lib/http';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { mergeSizeProfile, readSizeProfile } from '../../lib/sizeProfile';
import { verifyLoginWidget, verifyMiniAppInitData, type TelegramIdentity } from './telegramVerify';
import { checkLoginToken, createLoginToken, LOGIN_TOKEN_TTL_SECONDS } from './botLogin';

export const authRouter = Router();

/*
 * Rate limits, per purpose:
 *  - Customer sign-in is generous per IP: Ethiopian mobile carriers put many customers behind one
 *    public IP (CGNAT), so a tight per-IP limit would lock out real people at busy times. These
 *    endpoints can't be used to guess anything (Telegram signs the identity), so abuse risk is low.
 *  - Sign-in status polling is limited per sign-in token, not per IP.
 *  - Staff password login stays strict per IP: that one can be brute-forced.
 */
const signInLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 600 });
const staffLoginLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const pollLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 90, // polling every 2 s = 30/min, with headroom for a second tab
  keyGenerator: (req) => `poll:${String(req.params.token).slice(0, 64)}`,
});

export function publicUser(u: User) {
  return {
    id: u.id,
    role: u.role,
    fullName: u.fullName,
    phone: u.phone,
    /** the phone came from Telegram's Share-my-contact (it belongs to this Telegram account) */
    phoneVerified: Boolean(u.phone && u.phoneVerifiedAt),
    telegramId: u.telegramId?.toString() ?? null,
    telegramUsername: u.telegramUsername,
    photoUrl: u.photoUrl,
    languageCode: u.languageCode,
    city: u.city,
    area: u.area,
    landmark: u.landmark,
    newsOptIn: u.newsOptIn,
    sizeProfile: readSizeProfile(u.sizeProfile),
  };
}

function requireBotToken(): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new HttpError(503, 'Telegram sign-in is not configured', 'TELEGRAM_DISABLED');
  return env.TELEGRAM_BOT_TOKEN;
}

async function upsertTelegramCustomer(t: TelegramIdentity) {
  const fullName = [t.firstName, t.lastName].filter(Boolean).join(' ') || t.username || 'Customer';
  const user = await prisma.user.upsert({
    where: { telegramId: BigInt(t.id) },
    create: {
      telegramId: BigInt(t.id),
      telegramUsername: t.username,
      fullName,
      photoUrl: t.photoUrl,
      languageCode: t.languageCode === 'am' ? 'am' : 'en',
    },
    update: {
      telegramUsername: t.username,
      photoUrl: t.photoUrl,
    },
  });
  if (!user.isActive) throw unauthorized('This account is disabled');
  return user;
}

// Telegram Mini App: silent sign-in from initData
authRouter.post(
  '/telegram/miniapp',
  signInLimiter,
  validate(z.object({ initData: z.string().min(10).max(4096) })),
  ah(async (req, res) => {
    const identity = verifyMiniAppInitData(req.body.initData, requireBotToken());
    if (!identity) throw unauthorized('Telegram session could not be verified');
    const user = await upsertTelegramCustomer(identity);
    res.json({ token: signToken({ sub: user.id, role: 'CUSTOMER' }), user: publicUser(user) });
  }),
);

// Website: Telegram Login Widget
authRouter.post(
  '/telegram/widget',
  signInLimiter,
  validate(
    z.object({
      id: z.coerce.number().int().positive(),
      first_name: z.string().max(128),
      last_name: z.string().max(128).optional(),
      username: z.string().max(64).optional(),
      photo_url: z.string().url().max(512).optional(),
      auth_date: z.coerce.number().int(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  ah(async (req, res) => {
    const identity = verifyLoginWidget(req.body, requireBotToken());
    if (!identity) throw unauthorized('Telegram sign-in could not be verified');
    const user = await upsertTelegramCustomer(identity);
    res.json({ token: signToken({ sub: user.id, role: 'CUSTOMER' }), user: publicUser(user) });
  }),
);

// Website: sign in through the bot (no phone number, no code)
authRouter.post(
  '/telegram/bot-login',
  signInLimiter,
  ah(async (_req, res) => {
    requireBotToken();
    const { token, expiresAt } = await createLoginToken();
    res.json({
      token,
      url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: LOGIN_TOKEN_TTL_SECONDS,
    });
  }),
);

authRouter.get(
  '/telegram/bot-login/:token',
  pollLimiter,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const state = await checkLoginToken(String(req.params.token));
    if (state.status === 'pending') return res.json({ status: 'pending' });
    if (state.status === 'expired') return res.status(410).json({ status: 'expired' });
    const user = await upsertTelegramCustomer(state.identity);
    res.json({ status: 'confirmed', token: signToken({ sub: user.id, role: 'CUSTOMER' }), user: publicUser(user) });
  }),
);

// Development only: sign in as a test customer (the Telegram widget can't run on localhost)
if (!env.isProd && env.DEV_LOGIN) {
  authRouter.post(
    '/dev',
    ah(async (_req, res) => {
      const user = await prisma.user.upsert({
        where: { telegramId: BigInt(777000) },
        create: { telegramId: BigInt(777000), fullName: 'Test Buyer', telegramUsername: 'test_buyer' },
        update: {},
      });
      res.json({ token: signToken({ sub: user.id, role: 'CUSTOMER' }), user: publicUser(user) });
    }),
  );
}

// Staff (owner / admins): phone + password
authRouter.post(
  '/staff/login',
  staffLoginLimiter,
  validate(z.object({ phone: z.string().min(9).max(20), password: z.string().min(1).max(200) })),
  ah(async (req, res) => {
    const phone = normalizeEthiopianPhone(req.body.phone);
    const user = phone ? await prisma.user.findUnique({ where: { phone } }) : null;
    const ok =
      user &&
      user.isActive &&
      user.role !== 'CUSTOMER' &&
      user.passwordHash &&
      (await bcrypt.compare(req.body.password, user.passwordHash));
    if (!ok || !user) throw unauthorized('Wrong phone or password');
    res.json({ token: signToken({ sub: user.id, role: user.role }), user: publicUser(user) });
  }),
);

// Staff sign-in with Telegram (no password): same one-time bot link as customers, but only a
// Telegram account linked to an active admin/owner gets a staff session.
authRouter.post(
  '/staff/telegram',
  staffLoginLimiter,
  ah(async (_req, res) => {
    requireBotToken();
    const { token, expiresAt } = await createLoginToken();
    res.json({ token, url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`, expiresAt: expiresAt.toISOString() });
  }),
);

authRouter.get(
  '/staff/telegram/:token',
  pollLimiter,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const state = await checkLoginToken(String(req.params.token));
    if (state.status === 'pending') return res.json({ status: 'pending' });
    if (state.status === 'expired') return res.status(410).json({ status: 'expired' });
    const staff = await prisma.user.findFirst({ where: { staffTelegramId: BigInt(state.identity.id), role: { in: ['ADMIN', 'OWNER'] }, isActive: true } });
    if (!staff) return res.status(403).json({ status: 'not_staff', error: { message: 'This Telegram account isn’t an admin of the shop', code: 'NOT_STAFF' } });
    res.json({ status: 'confirmed', token: signToken({ sub: staff.id, role: staff.role }), user: publicUser(staff) });
  }),
);

// Forgot password (staff): a 6-digit code goes to the Telegram connected in Settings → Telegram → You.
// The answer never says whether the phone exists or has Telegram (no account probing).
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const RESET_MINUTES = 10;

authRouter.post(
  '/staff/forgot',
  staffLoginLimiter,
  validate(z.object({ phone: z.string().min(9).max(20) })),
  ah(async (req, res) => {
    const phone = normalizeEthiopianPhone(req.body.phone);
    const user = phone ? await prisma.user.findUnique({ where: { phone } }) : null;
    if (user && user.isActive && user.role !== 'CUSTOMER' && user.staffTelegramId) {
      const code = String(randomInt(100000, 1000000));
      await prisma.user.update({
        where: { id: user.id },
        data: { resetCodeHash: sha(code), resetExpires: new Date(Date.now() + RESET_MINUTES * 60_000), resetTries: 0 },
      });
      const { bot } = await import('../telegram/bot');
      if (user.role === 'OWNER') {
        const { ownerSend } = await import('../telegram/ownerChat');
        await ownerSend(
          user,
          `🔐 Your Hikma admin password reset code: <b>${code}</b>\n\nIt works for ${RESET_MINUTES} minutes. Didn’t ask for it? Ignore this — your password stays the same.`,
          { parse_mode: 'HTML' },
        );
      } else {
        await bot?.api
          .sendMessage(
            Number(user.staffTelegramId),
            `🔐 Your Hikma admin password reset code: <b>${code}</b>\n\nIt works for ${RESET_MINUTES} minutes. Didn’t ask for it? Ignore this — your password stays the same.`,
            { parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      }
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/staff/reset',
  staffLoginLimiter,
  validate(z.object({ phone: z.string().min(9).max(20), code: z.string().trim().regex(/^\d{6}$/), password: z.string().min(8).max(200) })),
  ah(async (req, res) => {
    const phone = normalizeEthiopianPhone(req.body.phone);
    const user = phone ? await prisma.user.findUnique({ where: { phone } }) : null;
    const bad = () => badRequest('Wrong or expired code — ask for a new one');
    if (!user || user.role === 'CUSTOMER' || !user.resetCodeHash || !user.resetExpires || user.resetExpires < new Date()) throw bad();
    if (user.resetTries >= 5) {
      await prisma.user.update({ where: { id: user.id }, data: { resetCodeHash: null, resetExpires: null } });
      throw bad();
    }
    const given = Buffer.from(sha(req.body.code));
    if (!timingSafeEqual(given, Buffer.from(user.resetCodeHash))) {
      await prisma.user.update({ where: { id: user.id }, data: { resetTries: { increment: 1 } } });
      throw bad();
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(req.body.password, 12), resetCodeHash: null, resetExpires: null, resetTries: 0 },
    });
    const { bot } = await import('../telegram/bot');
    if (updated.staffTelegramId) {
      if (updated.role === 'OWNER') {
        const { ownerSend } = await import('../telegram/ownerChat');
        await ownerSend(updated, '✅ Your Hikma admin password was changed.');
      } else {
        await bot?.api.sendMessage(Number(updated.staffTelegramId), '✅ Your Hikma admin password was changed.').catch(() => undefined);
      }
    }
    res.json({ token: signToken({ sub: updated.id, role: updated.role }), user: publicUser(updated) });
  }),
);

/**
 * Who am I. For customers this also renews the session (sliding expiry): the app calls it on start,
 * so anyone who keeps using the shop stays signed in; an unused session expires after 60 days.
 */
authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = req.user!;
    res.json({
      user: publicUser(user),
      ...(user.role === 'CUSTOMER' ? { token: signToken({ sub: user.id, role: 'CUSTOMER' }) } : {}),
    });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  validate(
    z.object({
      fullName: z.string().trim().min(2).max(80).optional(),
      phone: z.string().max(20).optional(),
      languageCode: z.enum(['en', 'am']).optional(),
      city: z.string().trim().max(60).optional(),
      area: z.string().trim().max(80).optional(),
      landmark: z.string().trim().max(160).optional(),
      newsOptIn: z.boolean().optional(),
      sizeProfile: z
        .object({
          height: z.number().int().min(120).max(230).optional(),
          weight: z.number().int().min(35).max(250).optional(),
          fit: z.enum(['slim', 'regular', 'loose']).optional(),
          sizes: z.record(z.string().max(60), z.string().max(20)).optional(),
        })
        .optional(),
    }),
  ),
  ah(async (req, res) => {
    const { phone, newsOptIn, sizeProfile, ...rest } = req.body as { phone?: string; newsOptIn?: boolean; sizeProfile?: Parameters<typeof mergeSizeProfile>[1] } & Record<string, string | undefined>;
    let normalized: string | undefined;
    if (phone !== undefined && req.user!.role === 'CUSTOMER') {
      const p = normalizeEthiopianPhone(phone);
      if (!p) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
      normalized = p;
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...rest,
        ...(normalized ? { phone: normalized } : {}),
        ...(newsOptIn !== undefined ? { newsOptIn, newsOptInAt: newsOptIn ? new Date() : null } : {}),
        ...(sizeProfile ? { sizeProfile: mergeSizeProfile(req.user!.sizeProfile, sizeProfile) } : {}),
      },
    });
    res.json({ user: publicUser(user) });
  }),
);

authRouter.post(
  '/staff/password',
  requireAuth,
  validate(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })),
  ah(async (req, res) => {
    const user = req.user!;
    if (user.role === 'CUSTOMER' || !user.passwordHash) throw unauthorized();
    if (!(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is wrong', 'PASSWORD');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(req.body.newPassword, 12) },
    });
    res.json({ ok: true });
  }),
);

/** Staff: one-tap link to connect their own Telegram (actions on order cards are then theirs). */
authRouter.post(
  '/staff-telegram',
  requireAuth,
  ah(async (req, res) => {
    const user = req.user!;
    if (user.role === 'CUSTOMER') throw unauthorized('Staff only');
    // <time>-<random>: the bot refuses links older than 15 minutes
    const code = `${Date.now().toString(36)}-${(await import('node:crypto')).randomBytes(9).toString('hex')}`;
    await prisma.user.update({ where: { id: user.id }, data: { staffLinkCode: code } });
    res.json({ url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=stf_${code}`, connected: user.staffTelegramId !== null });
  }),
);

/** Staff: which Telegram is connected (name looked up live from Telegram). */
authRouter.get(
  '/staff-telegram',
  requireAuth,
  ah(async (req, res) => {
    const user = req.user!;
    if (user.role === 'CUSTOMER') throw unauthorized('Staff only');
    res.set('Cache-Control', 'no-store');
    if (!user.staffTelegramId) return void res.json({ connected: false });
    const { bot } = await import('../telegram/bot');
    const chat = bot ? ((await bot.api.getChat(Number(user.staffTelegramId)).catch(() => null)) as { first_name?: string; last_name?: string; username?: string } | null) : null;
    // Small profile photo as a data URL (the file URL contains the bot token — never sent to the browser)
    let photo: string | null = null;
    try {
      const p = bot ? await bot.api.getUserProfilePhotos(Number(user.staffTelegramId), { limit: 1 }) : null;
      const small = p?.photos[0]?.[0];
      if (small && bot) {
        const file = await bot.api.getFile(small.file_id);
        const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
        if (r.ok) photo = `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
      }
    } catch {
      photo = null;
    }
    res.json({
      connected: true,
      name: [chat?.first_name, chat?.last_name].filter(Boolean).join(' ') || 'Telegram account',
      username: chat?.username ?? null,
      photo,
    });
  }),
);

authRouter.delete(
  '/staff-telegram',
  requireAuth,
  ah(async (req, res) => {
    const user = req.user!;
    if (user.role === 'CUSTOMER') throw unauthorized('Staff only');
    await prisma.user.update({ where: { id: user.id }, data: { staffTelegramId: null, staffLinkCode: null, staffTopicId: null } });
    res.json({ connected: false });
  }),
);

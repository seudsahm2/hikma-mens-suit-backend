import { Router } from 'express';
import rateLimit from 'express-rate-limit';
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
import { verifyLoginWidget, verifyMiniAppInitData, type TelegramIdentity } from './telegramVerify';
import { checkLoginToken, createLoginToken } from './botLogin';

export const authRouter = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

export function publicUser(u: User) {
  return {
    id: u.id,
    role: u.role,
    fullName: u.fullName,
    phone: u.phone,
    telegramId: u.telegramId?.toString() ?? null,
    telegramUsername: u.telegramUsername,
    photoUrl: u.photoUrl,
    languageCode: u.languageCode,
    city: u.city,
    area: u.area,
    landmark: u.landmark,
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
  authLimiter,
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
  authLimiter,
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
const pollLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

authRouter.post(
  '/telegram/bot-login',
  authLimiter,
  ah(async (_req, res) => {
    requireBotToken();
    const token = createLoginToken();
    res.json({
      token,
      url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`,
      expiresInSeconds: 300,
    });
  }),
);

authRouter.get(
  '/telegram/bot-login/:token',
  pollLimiter,
  ah(async (req, res) => {
    const state = checkLoginToken(String(req.params.token));
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
  authLimiter,
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

authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json({ user: publicUser(req.user!) });
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
    }),
  ),
  ah(async (req, res) => {
    const { phone, ...rest } = req.body as { phone?: string } & Record<string, string | undefined>;
    let normalized: string | undefined;
    if (phone !== undefined && req.user!.role === 'CUSTOMER') {
      const p = normalizeEthiopianPhone(phone);
      if (!p) throw badRequest('Enter a valid Ethiopian phone number', 'PHONE');
      normalized = p;
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { ...rest, ...(normalized ? { phone: normalized } : {}) },
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

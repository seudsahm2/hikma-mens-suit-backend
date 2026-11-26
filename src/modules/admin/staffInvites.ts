/**
 * Admins join through Telegram — no passwords to share:
 *   1. owner invites a phone or @username (Admins page) → if that person already uses the bot they get
 *      "Accept / Decline" right away; otherwise the owner sends them the invite link;
 *   2. they accept in Telegram (their real account is captured: id, name, username);
 *   3. the owner approves → a staff account linked to that Telegram is created; they sign in with Telegram.
 * Owners can also search everyone (customers, delivery people, admins) to make admin / revoke later.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { env } from '../../config/env';
import { ah, badRequest, conflict, notFound } from '../../lib/http';
import { logger } from '../../lib/logger';
import { normalizeEthiopianPhone } from '../../lib/phone';
import { prisma } from '../../lib/prisma';
import { requireOwner, requireStaff } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { bot } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

const INVITE_DAYS = 7;
const owner = [requireStaff, requireOwner];
export const staffInvitesRouter = Router();

const inviteLink = (code: string) => `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=si_${code}`;
const adminUrl = () => `${env.clientUrl}/admin`;
const tell = (telegramId: bigint | number | string, text: string, extra: object = {}) =>
  bot?.api.sendMessage(String(telegramId), text, { parse_mode: 'HTML', ...extra }).catch((err) => logger.warn({ err: (err as Error).message }, 'staff message not delivered'));

async function ownerName(id: string) {
  return (await prisma.user.findUnique({ where: { id }, select: { fullName: true } }))?.fullName ?? 'The owner';
}

/** A person known to the bot by phone or @username (customers and delivery people). */
async function findTelegramPerson(contact: string) {
  const username = contact.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
  const phone = normalizeEthiopianPhone(contact);
  if (phone) {
    const u = await prisma.user.findFirst({ where: { phone, telegramId: { not: null } } });
    if (u) return { telegramId: u.telegramId!, name: u.fullName, username: u.telegramUsername };
    const d = await prisma.driver.findFirst({ where: { phone, telegramId: { not: null } } });
    if (d) return { telegramId: d.telegramId!, name: d.name, username: null };
  }
  if (/^[A-Za-z0-9_]{4,32}$/.test(username)) {
    const u = await prisma.user.findFirst({ where: { telegramUsername: { equals: username, mode: 'insensitive' }, telegramId: { not: null } } });
    if (u) return { telegramId: u.telegramId!, name: u.fullName, username: u.telegramUsername };
  }
  return null;
}

const inviteKeyboard = (id: string) => new InlineKeyboard().text('✅ Accept', `si:${id}:yes`).text('❌ Decline', `si:${id}:no`);

/** Creates the staff account for a Telegram person (or re-activates it). */
async function makeAdmin(p: { telegramId: bigint; name: string; username?: string | null }, byId: string) {
  const existing = await prisma.user.findFirst({ where: { staffTelegramId: p.telegramId } });
  if (existing?.role === 'OWNER') throw conflict('This is the owner’s account', 'IS_OWNER');
  if (existing?.role === 'ADMIN' && existing.isActive) throw conflict(`${existing.fullName} is already an admin`, 'ALREADY');
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', isActive: true, fullName: p.name } })
    : await prisma.user.create({ data: { role: 'ADMIN', fullName: p.name, staffTelegramId: p.telegramId, telegramUsername: p.username ?? null } });
  await tell(
    p.telegramId,
    `✅ <b>You’re now an admin of Hikma Men’s Fashion</b> (added by ${escapeHtml(await ownerName(byId))}).\n\nOpen ${adminUrl()} and tap <b>Sign in with Telegram</b> — no password needed.`,
    { link_preview_options: { is_disabled: true } },
  );
  return user;
}

// ─── Routes (owner only) ─────────────────────────────────

staffInvitesRouter.get(
  '/staff/invites',
  ...owner,
  ah(async (_req, res) => {
    const invites = await prisma.staffInvite.findMany({ where: { status: { in: ['sent', 'accepted', 'declined'] }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    res.set('Cache-Control', 'no-store');
    res.json({ invites: invites.map((i) => ({ id: i.id, contact: i.contact, status: i.status, name: i.name, username: i.username, createdAt: i.createdAt, respondedAt: i.respondedAt, link: inviteLink(i.code) })) });
  }),
);

staffInvitesRouter.post(
  '/staff/invites',
  ...owner,
  validate(z.object({ contact: z.string().trim().min(3).max(80) })),
  ah(async (req, res) => {
    const contact = req.body.contact as string;
    if (!normalizeEthiopianPhone(contact) && !/^@?[A-Za-z0-9_]{4,32}$/.test(contact.replace(/^https?:\/\/t\.me\//, '')))
      throw badRequest('Enter a phone number (09…) or a Telegram @username', 'CONTACT');
    const person = await findTelegramPerson(contact);
    const invite = await prisma.staffInvite.create({
      data: {
        code: randomBytes(12).toString('base64url'),
        contact,
        createdById: req.user!.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        ...(person ? { telegramId: person.telegramId, name: person.name, username: person.username } : {}),
      },
    });
    // Known to the bot → they get the question right away; otherwise the owner shares the link
    let delivered = false;
    if (person && bot) {
      delivered = Boolean(
        await tell(person.telegramId, `👋 <b>${escapeHtml(await ownerName(req.user!.id))}</b> invites you to be an <b>admin</b> of Hikma Men’s Fashion.`, {
          reply_markup: inviteKeyboard(invite.id),
        }),
      );
    }
    res.status(201).json({ invite: { id: invite.id, status: invite.status, name: invite.name, link: inviteLink(invite.code) }, delivered });
  }),
);

staffInvitesRouter.post(
  '/staff/invites/:id/approve',
  ...owner,
  ah(async (req, res) => {
    const inv = await prisma.staffInvite.findUnique({ where: { id: req.params.id } });
    if (!inv || inv.expiresAt < new Date()) throw notFound('Invite not found or expired');
    if (inv.status !== 'accepted' || !inv.telegramId) throw conflict('They haven’t accepted in Telegram yet', 'NOT_ACCEPTED');
    const user = await makeAdmin({ telegramId: inv.telegramId, name: inv.name ?? inv.contact, username: inv.username }, req.user!.id);
    await prisma.staffInvite.update({ where: { id: inv.id }, data: { status: 'approved', staffUserId: user.id } });
    res.json({ ok: true });
  }),
);

staffInvitesRouter.delete(
  '/staff/invites/:id',
  ...owner,
  ah(async (req, res) => {
    await prisma.staffInvite.updateMany({ where: { id: req.params.id, status: { in: ['sent', 'accepted', 'declined'] } }, data: { status: 'cancelled' } });
    res.json({ ok: true });
  }),
);

/** Everyone the shop knows on Telegram: customers, delivery people, admins — to make admin / revoke. */
staffInvitesRouter.get(
  '/staff/people',
  ...owner,
  validate(z.object({ q: z.string().trim().max(60).default('') }), 'query'),
  ah(async (req, res) => {
    const q = (req.query as unknown as { q: string }).q;
    const text = q ? { contains: q.replace(/^@/, ''), mode: 'insensitive' as const } : undefined;
    const [users, drivers, staff] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'CUSTOMER', telegramId: { not: null }, ...(text ? { OR: [{ fullName: text }, { telegramUsername: text }, { phone: { contains: q } }] } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.driver.findMany({ where: { telegramId: { not: null }, ...(text ? { OR: [{ name: text }, { phone: { contains: q } }] } : {}) }, take: 10 }),
      prisma.user.findMany({ where: { role: { in: ['ADMIN', 'OWNER'] }, ...(text ? { OR: [{ fullName: text }, { phone: { contains: q } }] } : {}) }, orderBy: { createdAt: 'asc' } }),
    ]);
    const adminByTg = new Map(staff.filter((s) => s.staffTelegramId).map((s) => [s.staffTelegramId!.toString(), s]));
    const people = [
      ...staff.map((s) => ({ key: `s-${s.id}`, kind: s.role === 'OWNER' ? 'owner' : 'admin', name: s.fullName, phone: s.phone, username: s.telegramUsername, telegramId: s.staffTelegramId?.toString() ?? null, staffId: s.id, active: s.isActive })),
      ...drivers.map((d) => ({ key: `d-${d.id}`, kind: 'driver', name: d.name, phone: d.phone, username: null as string | null, telegramId: d.telegramId!.toString(), staffId: adminByTg.get(d.telegramId!.toString())?.id ?? null, active: true })),
      ...users.map((u) => ({ key: `u-${u.id}`, kind: 'customer', name: u.fullName, phone: u.phone, username: u.telegramUsername, telegramId: u.telegramId!.toString(), staffId: adminByTg.get(u.telegramId!.toString())?.id ?? null, active: true })),
    ];
    res.set('Cache-Control', 'no-store');
    res.json({ people });
  }),
);

staffInvitesRouter.post(
  '/staff/promote',
  ...owner,
  validate(z.object({ telegramId: z.string().regex(/^\d{3,20}$/), name: z.string().trim().min(1).max(80) })),
  ah(async (req, res) => {
    // Only people the shop already knows on Telegram (customers / delivery people)
    const tg = BigInt(req.body.telegramId);
    const known = (await prisma.user.findFirst({ where: { telegramId: tg } })) ?? (await prisma.driver.findFirst({ where: { telegramId: tg } }));
    if (!known) throw notFound('This person isn’t known to the shop’s bot — send them an invite instead');
    const user = await makeAdmin({ telegramId: tg, name: req.body.name }, req.user!.id);
    res.json({ staffId: user.id });
  }),
);

// ─── Bot: accept / decline ───────────────────────────────

/** /start si_<code> — the invite link. */
export async function openInvite(ctx: { from?: { id: number; first_name: string; last_name?: string; username?: string }; reply: (t: string, e?: object) => Promise<unknown> }, code: string) {
  const inv = await prisma.staffInvite.findUnique({ where: { code } });
  if (!inv || inv.expiresAt < new Date() || !['sent', 'accepted'].includes(inv.status)) return void (await ctx.reply('This invite has expired. Ask the owner for a new one.'));
  if (inv.telegramId && ctx.from && inv.telegramId !== BigInt(ctx.from.id)) return void (await ctx.reply('This invite was sent to someone else.'));
  await ctx.reply(`👋 <b>${escapeHtml(await ownerName(inv.createdById))}</b> invites you to be an <b>admin</b> of Hikma Men’s Fashion.`, { parse_mode: 'HTML', reply_markup: inviteKeyboard(inv.id) });
}

if (bot) {
  bot.callbackQuery(/^si:([a-z0-9]+):(yes|no)$/, async (ctx) => {
    const [, id, a] = ctx.match;
    const inv = await prisma.staffInvite.findUnique({ where: { id } });
    if (!inv || inv.expiresAt < new Date() || !['sent', 'accepted'].includes(inv.status)) {
      await ctx.answerCallbackQuery({ text: 'This invite has expired' });
      return void (await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined));
    }
    if (inv.telegramId && inv.telegramId !== BigInt(ctx.from.id)) return void (await ctx.answerCallbackQuery({ text: 'This invite is for someone else', show_alert: true }));
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    await prisma.staffInvite.update({
      where: { id: inv.id },
      data: { status: a === 'yes' ? 'accepted' : 'declined', telegramId: BigInt(ctx.from.id), name, username: ctx.from.username ?? null, respondedAt: new Date() },
    });
    await ctx.answerCallbackQuery({ text: a === 'yes' ? '✅ Accepted' : 'Declined' });
    await ctx.editMessageText(a === 'yes' ? '✅ Accepted — the owner will confirm, then you’ll get a message here.' : 'You declined the invite.').catch(() => undefined);
    // Tell the owner (their connected Telegram)
    const o = await prisma.user.findUnique({ where: { id: inv.createdById } });
    if (o?.staffTelegramId)
      await tell(
        o.staffTelegramId,
        a === 'yes'
          ? `✅ <b>${escapeHtml(name)}</b>${ctx.from.username ? ` (@${escapeHtml(ctx.from.username)})` : ''} accepted your admin invite.\nOpen Admins in the admin to confirm: ${adminUrl()}/staff`
          : `❌ ${escapeHtml(name)} declined your admin invite.`,
        { link_preview_options: { is_disabled: true } },
      );
  });
}

/** Revoking: tell them on Telegram (called by DELETE /staff/:id). */
export async function tellRevoked(staffTelegramId: bigint | null) {
  if (staffTelegramId) await tell(staffTelegramId, 'ℹ️ Your admin access to Hikma Men’s Fashion was removed by the owner.');
}

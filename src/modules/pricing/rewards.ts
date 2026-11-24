/**
 * Loyalty & invites. Credit is only ever earned on orders the customer actually RECEIVED
 * (delivered / picked up), so placing and cancelling orders earns nothing.
 * Every award is unique per (user, order, reason) in the database — it can never be given twice.
 */
import { randomInt } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot, shopUrl } from '../telegram/bot';
import { creditBalance, resolveInvite } from './pricing';

/** VIP levels by total received spend. Higher levels earn more credit per order. */
export const TIERS = [
  { id: 'member', name: 'Member', from: 0, multiplier: 1 },
  { id: 'gold', name: 'Gold', from: 50_000, multiplier: 1.5 },
  { id: 'vip', name: 'VIP', from: 150_000, multiplier: 2 },
] as const;

const RECEIVED = ['DELIVERED', 'PICKED_UP'] as const;

export async function lifetimeSpend(userId: string) {
  const agg = await prisma.order.aggregate({ where: { userId, status: { in: [...RECEIVED] } }, _sum: { total: true } });
  return agg._sum.total ?? 0;
}

export function tierFor(spend: number) {
  return [...TIERS].reverse().find((t) => spend >= t.from)!;
}

async function addCredit(userId: string, amount: number, reason: string, orderId: string | null, note: string) {
  if (amount <= 0 && reason !== 'redeem') return false;
  try {
    await prisma.creditEntry.create({ data: { userId, amount, reason, orderId, note } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false; // already given
    throw err;
  }
}

async function tell(userId: string, text: string) {
  if (!bot) return;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
  if (!u?.telegramId) return;
  await bot.api
    .sendMessage(Number(u.telegramId), text, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('🎁  My rewards', shopUrl('/orders')) })
    .catch(() => undefined);
}

/** Called when an order becomes DELIVERED / PICKED_UP. */
export async function onOrderReceived(orderId: string) {
  const [order, settings] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.settings.findUnique({ where: { id: 'default' } }),
  ]);
  if (!order?.userId || !settings) return;

  // Loyalty: a share of what they paid (credit spent on this order doesn't earn)
  if (settings.loyaltyEnabled && settings.loyaltyPercent > 0) {
    const tier = tierFor(await lifetimeSpend(order.userId));
    const paid = Math.max(0, order.total - (order.deliveryFee ?? 0));
    const amount = Math.floor((paid * settings.loyaltyPercent * tier.multiplier) / 100);
    if (await addCredit(order.userId, amount, 'loyalty', order.id, `${order.orderNumber}`)) {
      await tell(order.userId, `🎁 You earned <b>${amount.toLocaleString('en-US')} ETB</b> Hikma credit on ${order.orderNumber}. Use it on your next order.`);
    }
  }

  // Invite: the friend received their first order → reward the person who invited them
  if (settings.referralEnabled && order.referrerId && order.referrerId !== order.userId) {
    const firstReceived = await prisma.order.count({ where: { userId: order.userId, status: { in: [...RECEIVED] }, id: { not: order.id } } });
    if (firstReceived === 0 && (await addCredit(order.referrerId, settings.referralReward, 'referral', order.id, `Friend's order ${order.orderNumber}`))) {
      await tell(order.referrerId, `🤝 Your friend received their order — you earned <b>${settings.referralReward.toLocaleString('en-US')} ETB</b> Hikma credit. Thank you!`);
    }
  }
}

/** Called when an order is cancelled: credit spent on it comes back, promo use is released. */
export async function onOrderCancelled(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  if (order.userId && order.creditUsed > 0) await addCredit(order.userId, order.creditUsed, 'refund', order.id, `Cancelled ${order.orderNumber}`);
  if (order.promotionId) {
    await prisma.promotion.updateMany({ where: { id: order.promotionId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function ensureReferralCode(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true, fullName: true } });
  if (u.referralCode) return u.referralCode;
  const stem = u.fullName.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'HIKMA';
  for (let i = 0; i < 6; i++) {
    const code = `${stem}${Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
    const updated = await prisma.user.updateMany({ where: { id: userId, referralCode: null }, data: { referralCode: code } }).catch(() => ({ count: 0 }));
    if (updated.count) return code;
    const again = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
    if (again.referralCode) return again.referralCode;
  }
  throw new Error('Could not create an invite code');
}

/** Everything the "My rewards" card shows. */
export async function rewardsSummary(userId: string) {
  const [settings, balance, spend, history, joined, ordered, rewarded] = await Promise.all([
    prisma.settings.findUniqueOrThrow({ where: { id: 'default' } }),
    creditBalance(userId),
    lifetimeSpend(userId),
    prisma.creditEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.user.count({ where: { referredById: userId } }),
    prisma.order.findMany({ where: { referrerId: userId, status: { not: 'CANCELLED' } }, select: { userId: true, status: true } }),
    prisma.creditEntry.aggregate({ where: { userId, reason: 'referral' }, _sum: { amount: true }, _count: true }),
  ]);
  const received = new Set(['DELIVERED', 'PICKED_UP']);
  const friendsOrdered = new Set(ordered.map((o) => o.userId)).size;
  const pendingFriends = new Set(ordered.filter((o) => !received.has(o.status)).map((o) => o.userId)).size;
  const tier = tierFor(spend);
  const next = TIERS.find((t) => t.from > spend) ?? null;
  const code = settings.referralEnabled ? await ensureReferralCode(userId) : null;
  return {
    loyalty: settings.loyaltyEnabled ? { percent: Math.round(settings.loyaltyPercent * tier.multiplier * 10) / 10 } : null,
    credit: balance,
    creditMaxPercent: settings.creditMaxPercent,
    tier: { id: tier.id, name: tier.name, spend, next: next ? { id: next.id, name: next.name, at: next.from } : null },
    referral: code
      ? {
          code,
          link: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?startapp=ref_${code}`,
          webLink: shopUrl(`/?ref=${code}`),
          reward: settings.referralReward,
          friendDiscount: settings.referralFriendDiscount,
          minSubtotal: settings.referralMinSubtotal,
          friends: {
            joined: Math.max(joined, friendsOrdered),
            ordered: friendsOrdered,
            rewarded: rewarded._count,
            earned: rewarded._sum.amount ?? 0,
            pending: pendingFriends * settings.referralReward,
          },
        }
      : null,
    history: history.map((h) => ({ id: h.id, amount: h.amount, reason: h.reason, note: h.note, createdAt: h.createdAt })),
  };
}

/**
 * A signed-in customer arrived with an invite code (link opened in Telegram or on the website):
 * save the inviter on their account right away, so the invite follows them to any device.
 */
export async function attachInvite(userId: string, code: string) {
  const [user, settings] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.settings.findUniqueOrThrow({ where: { id: 'default' } }),
  ]);
  if (user.referredById) return { attached: false, reason: 'already' as const };
  const { inviter, error } = await resolveInvite(user, code, settings, Number.MAX_SAFE_INTEGER);
  if (!inviter || error) return { attached: false, reason: error ?? 'invalid' };
  const saved = await prisma.user.updateMany({ where: { id: userId, referredById: null }, data: { referredById: inviter.id } });
  if (saved.count) {
    const first = user.fullName.split(/\s+/)[0] ?? 'Your friend';
    await tell(inviter.id, `🤝 <b>${first}</b> joined with your invite. You get <b>${settings.referralReward.toLocaleString('en-US')} ETB</b> credit when their first order arrives.`);
  }
  return { attached: saved.count > 0, inviterName: inviter.fullName.split(/\s+/)[0] ?? '' };
}

/** The friend placed an order with the invite → let the inviter know a reward is on the way. */
export async function onOrderPlaced(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: { select: { fullName: true } } } });
  if (!order?.referrerId) return;
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
  const first = order.user?.fullName.split(/\s+/)[0] ?? 'Your friend';
  await tell(order.referrerId, `🛍 <b>${first}</b> placed their first order. Your <b>${settings.referralReward.toLocaleString('en-US')} ETB</b> credit arrives as soon as it’s delivered.`);
}

/** Failures here must never break an order status change. */
export function safely(fn: () => Promise<void>, what: string) {
  fn().catch((err) => logger.warn({ err }, `${what} failed`));
}

/**
 * The one place prices are decided. Used for the live checkout quote AND when the order is created,
 * so the customer always pays exactly what they were shown. Nothing here trusts the browser.
 *
 * Order of discounts:
 *   1. "Complete the look" bundles — automatic, item level, always stack
 *   2. ONE promotion — the best of: running campaigns or the promo code the customer typed
 *   3. A friend's invite (first order only) — stacks, so a running sale never cancels an invite
 *   4. Shop credit — if the customer chooses to use it, up to Settings.creditMaxPercent of what's left
 */
import type { Prisma, Promotion, Settings, User } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface PriceLine {
  variantId: string;
  productId: string;
  categorySlug: string;
  unitPrice: number;
  quantity: number;
}

export interface DiscountLine {
  kind: 'bundle' | 'promo' | 'referral' | 'credit';
  label: string;
  amount: number;
  code?: string;
}

export interface Quote {
  subtotal: number;
  discounts: DiscountLine[];
  discountTotal: number;
  /** subtotal − discounts (delivery is added by the caller) */
  itemsTotal: number;
  promotion: Pick<Promotion, 'id' | 'name' | 'code' | 'type'> | null;
  giftNote: string | null;
  referrerId: string | null;
  creditUsed: number;
  creditBalance: number;
  /** why the typed code didn't apply (shown under the code field) */
  codeError: string | null;
  codeApplied: boolean;
  /** the invite that applies (from a link, a typed invite code, or the account's saved inviter) */
  invite: { code: string | null; inviterName: string } | null;
  inviteError: string | null;
}

const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);

export async function creditBalance(userId: string, db: Prisma.TransactionClient = prisma) {
  const agg = await db.creditEntry.aggregate({ where: { userId }, _sum: { amount: true } });
  return Math.max(0, agg._sum.amount ?? 0);
}

/** Customer has no earlier order that wasn't cancelled (invites are for new customers only). */
async function isNewCustomer(userId: string) {
  return (await prisma.order.count({ where: { userId, status: { not: 'CANCELLED' } } })) === 0;
}

function promoRunning(p: Promotion, now: Date) {
  return p.isActive && (!p.startsAt || p.startsAt <= now) && (!p.endsAt || p.endsAt > now) && (p.maxUses === null || p.usedCount < p.maxUses);
}

// ─── 1. Bundles ──────────────────────────────────────────

async function bundleDiscounts(lines: PriceLine[]): Promise<DiscountLine[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  if (productIds.length < 2) return [];
  const bundles = await prisma.bundle.findMany({
    where: { isActive: true, items: { some: { productId: { in: productIds } } } },
    include: { items: true },
  });
  // Pieces of each product still free to count toward a bundle, and its cheapest unit price
  const qty = new Map<string, number>();
  const price = new Map<string, number>();
  for (const l of lines) {
    qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
    price.set(l.productId, Math.min(price.get(l.productId) ?? Infinity, l.unitPrice));
  }
  const complete = bundles.filter((b) => b.items.length >= 2 && b.items.every((i) => qty.has(i.productId)));
  // Biggest saving first; a piece counts toward one bundle only
  complete.sort((a, b) => b.items.reduce((n, i) => n + (price.get(i.productId) ?? 0), 0) * b.discountPercent - a.items.reduce((n, i) => n + (price.get(i.productId) ?? 0), 0) * a.discountPercent);
  const out: DiscountLine[] = [];
  for (const b of complete) {
    const sets = Math.min(...b.items.map((i) => qty.get(i.productId) ?? 0));
    if (sets <= 0) continue;
    const setPrice = b.items.reduce((n, i) => n + (price.get(i.productId) ?? 0), 0);
    const amount = pct(setPrice * sets, b.discountPercent);
    if (amount <= 0) continue;
    b.items.forEach((i) => qty.set(i.productId, (qty.get(i.productId) ?? 0) - sets));
    out.push({ kind: 'bundle', label: b.name, amount });
  }
  return out;
}

// ─── 2. Promotions ───────────────────────────────────────

function promoAmount(p: Promotion, lines: PriceLine[], base: number) {
  const eligible = p.categorySlug ? lines.filter((l) => l.categorySlug === p.categorySlug).reduce((n, l) => n + l.unitPrice * l.quantity, 0) : base;
  if (!eligible || eligible < p.minSubtotal) return null;
  const amount = p.type === 'PERCENT' ? pct(Math.min(eligible, base), p.value) : p.type === 'FIXED' ? Math.min(p.value, eligible, base) : 0;
  return amount;
}

interface Candidate {
  amount: number;
  line: DiscountLine | null;
  promotion: Promotion | null;
  gift: string | null;
  referrerId: string | null;
  typed: boolean;
}

async function bestPromotion(lines: PriceLine[], base: number, user: User | null, typedCode: string | null, settings: Settings) {
  const now = new Date();
  const candidates: Candidate[] = [];
  let codeError: string | null = null;
  let typedInvite: string | null = null;

  // Running campaigns (no code)
  const auto = await prisma.promotion.findMany({ where: { code: null, isActive: true } });
  for (const p of auto) {
    if (!promoRunning(p, now)) continue;
    const amount = promoAmount(p, lines, base);
    if (amount === null) continue;
    candidates.push({
      amount,
      line: amount > 0 ? { kind: 'promo', label: p.name, amount } : null,
      promotion: p,
      gift: p.type === 'GIFT' ? p.giftText : null,
      referrerId: null,
      typed: false,
    });
  }

  // The code the customer typed: a promo code or a friend's invite code
  if (typedCode) {
    const code = typedCode.trim().toUpperCase();
    const promo = await prisma.promotion.findUnique({ where: { code } });
    if (promo) {
      const amount = promoRunning(promo, now) ? promoAmount(promo, lines, base) : null;
      const usedBefore =
        promo.onePerCustomer && user ? await prisma.order.count({ where: { userId: user.id, promotionId: promo.id, status: { not: 'CANCELLED' } } }) : 0;
      if (!promoRunning(promo, now)) codeError = 'This code has ended';
      else if (amount === null) codeError = promo.minSubtotal ? `This code needs ${promo.minSubtotal.toLocaleString('en-US')} ETB or more` : 'This code doesn’t apply to these items';
      else if (usedBefore) codeError = 'You already used this code';
      else
        candidates.push({
          amount,
          line: amount > 0 ? { kind: 'promo', label: promo.name, amount, code } : null,
          promotion: promo,
          gift: promo.type === 'GIFT' ? promo.giftText : null,
          referrerId: null,
          typed: true,
        });
    } else {
      typedInvite = code; // not a promo code: maybe a friend's invite code (checked in the invite step)
    }
  }

  // Best money saving wins; on a tie (or gift vs gift) the code the customer typed wins
  candidates.sort((a, b) => b.amount - a.amount || Number(b.typed) - Number(a.typed));
  const best = candidates[0] ?? null;
  const codeApplied = Boolean(best?.typed);
  if (typedCode && !typedInvite && !codeError && !codeApplied) codeError = 'A better offer is already applied';
  return { best, codeError, codeApplied, typedInvite };
}

// ─── 3. Friend's invite ──────────────────────────────────

/**
 * Who invited this customer: the invite code they came with (link / typed), or the inviter already
 * saved on their account. Only for a customer's first order.
 */
export async function resolveInvite(user: User | null, code: string | null, settings: Settings, base: number) {
  if (!settings.referralEnabled) return { inviter: null, error: code ? 'Invites are not active right now' : null };
  const inviter = code
    ? await prisma.user.findUnique({ where: { referralCode: code.trim().toUpperCase() } })
    : user?.referredById
      ? await prisma.user.findUnique({ where: { id: user.referredById } })
      : null;
  if (!inviter) return { inviter: null, error: code ? 'This code doesn’t exist' : null };
  if (user && inviter.id === user.id) return { inviter: null, error: 'This is your own invite — share it with friends' };
  if (user && !(await isNewCustomer(user.id))) return { inviter: null, error: code ? 'Invites are for a first order' : null };
  if (base < settings.referralMinSubtotal) return { inviter, error: `Your friend’s invite applies from ${settings.referralMinSubtotal.toLocaleString('en-US')} ETB`, tooSmall: true };
  return { inviter, error: null };
}

// ─── Quote ───────────────────────────────────────────────

export async function quote(lines: PriceLine[], opts: { user: User | null; code?: string | null; invite?: string | null; useCredit?: boolean }): Promise<Quote> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 'default' } });
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0);
  const discounts: DiscountLine[] = [];

  discounts.push(...(await bundleDiscounts(lines)));
  let remaining = subtotal - discounts.reduce((n, d) => n + d.amount, 0);

  const { best, codeError, codeApplied, typedInvite } = await bestPromotion(lines, remaining, opts.user, opts.code ?? null, settings);
  if (best?.line) {
    best.line.amount = Math.min(best.line.amount, remaining);
    discounts.push(best.line);
    remaining -= best.line.amount;
  }

  // Invite stacks on top (a typed invite code wins over a link's)
  const inviteCode = typedInvite ?? opts.invite ?? null;
  const inv = await resolveInvite(opts.user, inviteCode, settings, remaining);
  let referrerId: string | null = null;
  if (inv.inviter && !inv.tooSmall && remaining > 0) {
    const amount = Math.min(settings.referralFriendDiscount, remaining);
    if (amount > 0) {
      discounts.push({ kind: 'referral', label: 'Friend’s invite', amount, ...(inviteCode ? { code: inviteCode.toUpperCase() } : {}) });
      remaining -= amount;
      referrerId = inv.inviter.id;
    }
  }

  const balance = opts.user ? await creditBalance(opts.user.id) : 0;
  let creditUsed = 0;
  if (opts.useCredit && balance > 0 && remaining > 0) {
    creditUsed = Math.min(balance, Math.floor((remaining * settings.creditMaxPercent) / 100));
    if (creditUsed > 0) {
      discounts.push({ kind: 'credit', label: 'Hikma credit', amount: creditUsed });
      remaining -= creditUsed;
    }
  }

  const discountTotal = discounts.reduce((n, d) => n + d.amount, 0);
  return {
    subtotal,
    discounts,
    discountTotal,
    itemsTotal: subtotal - discountTotal,
    promotion: best?.promotion ? { id: best.promotion.id, name: best.promotion.name, code: best.promotion.code, type: best.promotion.type } : null,
    giftNote: best?.gift ?? null,
    referrerId,
    creditUsed,
    creditBalance: balance,
    codeError: typedInvite ? inv.error : codeError,
    codeApplied: codeApplied || Boolean(typedInvite && referrerId),
    invite: inv.inviter && referrerId ? { code: inviteCode, inviterName: inv.inviter.fullName.split(/\s+/)[0] ?? '' } : null,
    inviteError: typedInvite ? null : inv.error,
  };
}

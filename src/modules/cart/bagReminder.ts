/**
 * Abandoned-bag reminder: a signed-in customer who leaves items in the bag gets ONE short
 * Telegram message a few hours later — only in the daytime, only for items still in stock,
 * at most once every few days. Claimed with a conditional update, so it is never sent twice.
 */
import { InlineKeyboard } from 'grammy';
import { addisHour } from '../../lib/addisTime';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot, shopUrl } from '../telegram/bot';
import { escapeHtml } from '../telegram/media';

export const REMIND_AFTER_MS = 3 * 3600_000; // left untouched this long
const GIVE_UP_AFTER_MS = 48 * 3600_000; // older bags are not worth a message
const MIN_GAP_MS = 72 * 3600_000; // never more than one reminder per customer in 3 days
const DAY_START = 9;
const DAY_END = 20; // Addis time: no messages at night

type Item = { variantId: string; quantity: number };

export async function sendBagReminders(now = new Date()) {
  if (!bot) return 0;
  const hour = addisHour(now);
  if (hour < DAY_START || hour >= DAY_END) return 0;
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (settings && !settings.bagReminders) return 0;

  const due = await prisma.cartSnapshot.findMany({
    where: {
      itemCount: { gt: 0 },
      updatedAt: { lte: new Date(now.getTime() - REMIND_AFTER_MS), gte: new Date(now.getTime() - GIVE_UP_AFTER_MS) },
      OR: [{ remindedAt: null }, { remindedAt: { lt: new Date(now.getTime() - MIN_GAP_MS) } }],
      user: { telegramId: { not: null }, isActive: true, role: 'CUSTOMER' },
    },
    include: { user: true },
    take: 20,
  });

  let sent = 0;
  for (const snap of due) {
    // Claim: whoever flips remindedAt first sends it
    const claimed = await prisma.cartSnapshot.updateMany({
      where: { userId: snap.userId, updatedAt: snap.updatedAt, remindedAt: snap.remindedAt },
      // updatedAt is @updatedAt: keep it, so it still means "last changed by the customer"
      data: { remindedAt: now, updatedAt: snap.updatedAt },
    });
    if (!claimed.count) continue;

    const items = snap.items as Item[];
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: items.map((i) => i.variantId) }, isActive: true, stock: { gt: 0 }, product: { status: 'ACTIVE' } },
      include: { product: { select: { nameEn: true, nameAm: true } } },
    });
    if (!variants.length) continue; // everything sold out meanwhile: nothing to remind about

    const am = snap.user.languageCode === 'am';
    const first = variants[0]!;
    const name = escapeHtml((am && first.product.nameAm) || first.product.nameEn);
    const detail = [first.size, first.color].filter(Boolean).join(' · ');
    const more = variants.length - 1;
    const text = am
      ? `👋 በቦርሳዎ ውስጥ <b>${name}</b>${detail ? ` (${escapeHtml(detail)})` : ''}${more ? ` እና ሌሎች ${more}` : ''} አሉ። አሁንም አለ — ትዕዛዝዎን ይጨርሱ።`
      : `👋 You left <b>${name}</b>${detail ? ` (${escapeHtml(detail)})` : ''}${more ? ` and ${more} more` : ''} in your bag. Still available — finish your order whenever you’re ready.`;
    try {
      await bot.api.sendMessage(Number(snap.user.telegramId), text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().webApp(am ? '🛍  ቦርሳዬን ክፈት' : '🛍  Open my bag', shopUrl('/bag')),
      });
      sent++;
    } catch (err) {
      // 403 = never started the bot or blocked it; nothing else to do (already marked as reminded)
      logger.debug({ err: (err as Error).message, userId: snap.userId }, 'bag reminder not delivered');
    }
  }
  return sent;
}

export function startBagReminderWorker() {
  const timer = setInterval(() => {
    sendBagReminders().then(
      (n) => n && logger.info({ sent: n }, 'bag reminders sent'),
      (err) => logger.warn({ err }, 'bag reminders failed'),
    );
  }, 10 * 60_000);
  return () => clearInterval(timer);
}

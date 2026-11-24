import { InlineKeyboard } from 'grammy';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { bot, shopUrl } from '../telegram/bot';
import { birr, escapeHtml } from '../telegram/media';

/**
 * "Notify me when back": when a sold-out size/colour gets stock again (restock in the dashboard, a
 * cancelled order returning stock, inventory adjustment), everyone waiting for it gets one Telegram
 * message with an Order button. Each alert is claimed before sending, so nobody is messaged twice.
 */
export async function notifyBackInStock(variantIds: string[]): Promise<number> {
  if (!bot || !variantIds.length) return 0;
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: [...new Set(variantIds)] }, isActive: true, stock: { gt: 0 }, product: { status: 'ACTIVE' } },
    include: { product: true },
  });
  let sent = 0;
  for (const v of variants) {
    const alerts = await prisma.stockAlert.findMany({
      where: { variantId: v.id, notifiedAt: null },
      include: { user: true },
      take: 500,
    });
    for (const a of alerts) {
      // Claim first: concurrent restocks can't message the same person twice
      const claim = await prisma.stockAlert.updateMany({ where: { id: a.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
      if (!claim.count || !a.user.telegramId) continue;
      const am = a.user.languageCode === 'am';
      const detail = [v.size, v.color].filter(Boolean).join(' · ');
      const price = birr(v.price ?? v.product.basePrice);
      const text = am
        ? `🔔 <b>ተመልሶ መጥቷል!</b>\n${escapeHtml(v.product.nameAm || v.product.nameEn)}${detail ? ` · ${escapeHtml(detail)}` : ''}\n${price}`
        : `🔔 <b>Back in stock</b>\n${escapeHtml(v.product.nameEn)}${detail ? ` · ${escapeHtml(detail)}` : ''}\n${price}`;
      try {
        await bot.api.sendMessage(a.user.telegramId.toString(), text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp(am ? '🛍  አሁን ይዘዙ' : '🛍  Order now', shopUrl(`/p/${v.product.slug}`)),
        });
        sent++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, userId: a.userId }, 'back-in-stock message failed');
      }
      await new Promise((r) => setTimeout(r, 40)); // stay well under Telegram's 30 msg/s
    }
  }
  if (sent) logger.info({ sent }, 'back-in-stock alerts sent');
  return sent;
}

/** Fire-and-forget hook for code paths that add stock. */
export function onStockRestored(variantIds: string[]) {
  void notifyBackInStock(variantIds).catch((err) => logger.warn({ err }, 'back-in-stock failed'));
}

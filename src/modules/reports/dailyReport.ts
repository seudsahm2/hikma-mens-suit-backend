/**
 * Daily owner report: every evening a short summary goes to the order-alerts chat
 * (sales, payments to check, orders to prepare, sizes running out, best seller).
 * Also available any time with /report in that chat.
 *
 * "Sent once per day" is stored in the database (Settings.lastReportDate) and claimed with a
 * conditional update, so restarts, several servers or a late wake-up never send it twice.
 */
import { InlineKeyboard } from 'grammy';
import { addisDate, addisHour, startOfAddisDay } from '../../lib/addisTime';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot, shopUrl } from '../telegram/bot';
import { birr, escapeHtml } from '../telegram/media';

const LOW_STOCK = 1; // "last piece" sizes are listed by name

export async function buildDailyReport(now = new Date()) {
  const dayStart = startOfAddisDay(now);
  const yesterdayStart = new Date(dayStart.getTime() - 86400_000);
  const valid = { status: { not: 'CANCELLED' as const } };

  const [today, yesterday, bySource, top, toCheck, toPrepare, onTheWay, low, waiting, drafts] = await Promise.all([
    prisma.order.aggregate({ where: { createdAt: { gte: dayStart }, ...valid }, _sum: { total: true, costTotal: true }, _count: true }),
    prisma.order.aggregate({ where: { createdAt: { gte: yesterdayStart, lt: dayStart }, ...valid }, _sum: { total: true }, _count: true }),
    prisma.order.groupBy({ by: ['source'], where: { createdAt: { gte: dayStart }, ...valid }, _count: true }),
    prisma.orderItem.groupBy({
      by: ['productName'],
      where: { order: { createdAt: { gte: dayStart }, ...valid } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 1,
    }),
    prisma.order.count({ where: { paymentStatus: 'SUBMITTED', ...valid } }),
    prisma.order.count({ where: { status: { in: ['CONFIRMED', 'PACKING'] } } }),
    prisma.order.count({ where: { status: 'OUT_FOR_DELIVERY' } }),
    prisma.productVariant.findMany({
      where: { isActive: true, stock: { gte: 1, lte: LOW_STOCK }, product: { status: 'ACTIVE' } },
      include: { product: { select: { nameEn: true } } },
      orderBy: { product: { updatedAt: 'desc' } },
      take: 6,
    }),
    prisma.stockAlert.count({ where: { notifiedAt: null } }),
    prisma.product.count({ where: { status: 'DRAFT' } }),
  ]);

  const revenue = today._sum.total ?? 0;
  const prev = yesterday._sum.total ?? 0;
  const shop = bySource.find((s) => s.source === 'COUNTER')?._count ?? 0;
  const online = today._count - shop;
  const trend = prev ? Math.round(((revenue - prev) / prev) * 100) : null;

  const lines: string[] = [];
  lines.push(`📊 <b>Today · ${new Date(now.getTime() + 3 * 3600_000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</b>`);
  lines.push('');
  if (today._count) {
    lines.push(`💰 <b>${birr(revenue)}</b> · ${today._count} order${today._count === 1 ? '' : 's'}${trend !== null ? `  (${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% vs yesterday)` : ''}`);
    lines.push(`     ${online} online · ${shop} in the shop`);
    const profit = revenue - (today._sum.costTotal ?? 0);
    if (today._sum.costTotal) lines.push(`     Profit ≈ ${birr(profit)}`);
    if (top[0]?._sum.quantity) lines.push(`🏆 Best seller: ${escapeHtml(top[0].productName)} (${top[0]._sum.quantity})`);
  } else {
    lines.push('No sales yet today.');
  }

  const todo: string[] = [];
  if (toCheck) todo.push(`🧾 ${toCheck} payment${toCheck === 1 ? '' : 's'} to check`);
  if (toPrepare) todo.push(`📦 ${toPrepare} order${toPrepare === 1 ? '' : 's'} to prepare`);
  if (onTheWay) todo.push(`🚚 ${onTheWay} on the way`);
  if (drafts) todo.push(`📝 ${drafts} draft${drafts === 1 ? '' : 's'} not on sale yet`);
  if (todo.length) lines.push('', ...todo);

  if (low.length) {
    lines.push('', '⚠️ <b>Last piece</b>');
    for (const v of low) {
      const detail = [v.size, v.color].filter(Boolean).join(' / ');
      lines.push(`• ${escapeHtml(v.product.nameEn)}${detail ? ` · ${escapeHtml(detail)}` : ''}`);
    }
  }
  if (waiting) lines.push('', `🔔 ${waiting} customer${waiting === 1 ? ' is' : 's are'} waiting for sold-out sizes`);

  return lines.join('\n');
}

export async function sendDailyReport(chatId: string, now = new Date()) {
  if (!bot) return;
  await bot.api.sendMessage(chatId, await buildDailyReport(now), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().url('📈  Open dashboard', shopUrl('/admin')),
  });
}

/** Sends today's report once, after the configured hour. Safe to call as often as you like. */
export async function maybeSendDailyReport(now = new Date()) {
  if (!bot) return false;
  const s = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!s?.dailyReport || !s.adminChatId || addisHour(now) < s.reportHour) return false;
  const today = addisDate(now);
  if (s.lastReportDate === today) return false;
  // Claim today's report (only one caller wins)
  const claimed = await prisma.settings.updateMany({
    where: { id: 'default', OR: [{ lastReportDate: null }, { lastReportDate: { not: today } }] },
    data: { lastReportDate: today },
  });
  if (!claimed.count) return false;
  try {
    await sendDailyReport(s.adminChatId, now);
    return true;
  } catch (err) {
    // Give it back so the next check retries
    await prisma.settings.update({ where: { id: 'default' }, data: { lastReportDate: s.lastReportDate } }).catch(() => undefined);
    throw err;
  }
}

export function startDailyReportWorker() {
  const tick = () => maybeSendDailyReport().catch((err) => logger.warn({ err }, 'daily report failed'));
  const first = setTimeout(tick, 20_000); // also catches up after the server wakes from sleep
  const timer = setInterval(tick, 5 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

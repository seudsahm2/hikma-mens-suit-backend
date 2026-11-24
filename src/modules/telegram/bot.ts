import { Bot, InlineKeyboard, webhookCallback, type Context } from 'grammy';
import type { OrderStatus } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { consumeLinkCode } from './linkCodes';
import { confirmLoginToken } from '../auth/botLogin';
import { collectChannelPost, processReadyImports, toPostInput } from './channelImport';

/** The bot exists only when a token is configured; everything else degrades gracefully. */
export const bot: Bot | null = env.TELEGRAM_BOT_TOKEN ? new Bot(env.TELEGRAM_BOT_TOKEN) : null;

export function shopUrl(path = '/') {
  return `${env.clientUrl}${path}`;
}

/**
 * Link that opens the bot's Main Mini App (BotFather → Bot Settings → Configure Mini App → Main App).
 * Works in channels, where web_app buttons are not allowed, and doesn't depend on any short name.
 */
export function miniAppLink(startParam?: string) {
  const base = `https://t.me/${env.TELEGRAM_BOT_USERNAME}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : `${base}?startapp`;
}

function isAm(ctx: Context) {
  return ctx.from?.language_code === 'am';
}

/** Maps a /start or startapp payload to a frontend path. */
export function startParamToPath(param: string | undefined): string {
  if (!param) return '/';
  if (param.startsWith('p_')) return `/p/${param.slice(2)}`;
  if (param.startsWith('c_')) return `/shop/${param.slice(2)}`;
  if (param.startsWith('o_')) return `/orders/${param.slice(2)}`;
  return '/';
}

export type AdminAction = 'verify' | 'reject' | OrderStatus;

if (bot) {
  bot.catch((err) => logger.error({ err: err.error }, 'telegram bot error'));

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const am = isAm(ctx);

    // Website sign-in: /start login_<token>. ctx.from is Telegram's own verified sender info.
    const payload = String(ctx.match ?? '');
    if (payload.startsWith('login_') && ctx.from) {
      const ok = await confirmLoginToken(payload.slice(6), {
        id: ctx.from.id,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
        languageCode: ctx.from.language_code,
      });
      await ctx.reply(
        ok
          ? am
            ? '✅ ገብተዋል። ወደ ድረ-ገጹ ይመለሱ።'
            : '✅ You’re signed in. Go back to the website.'
          : am
            ? 'ይህ የመግቢያ ሊንክ ጊዜው አልፏል። በድረ-ገጹ ላይ እንደገና ይሞክሩ።'
            : 'This sign-in link has expired. Please try again on the website.',
        { reply_markup: new InlineKeyboard().url(am ? '🌐  ወደ ድረ-ገጹ' : '🌐  Back to the website', shopUrl('/')) },
      );
      return;
    }

    const path = startParamToPath(payload || undefined);
    const user = ctx.from ? await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } }) : null;
    const kb = new InlineKeyboard().webApp(am ? '🛍  ሱቁን ይክፈቱ' : '🛍  Open the shop', shopUrl(path));
    if (!user?.newsOptIn) kb.row().text(am ? '🔔  አዲስ ዕቃ ሲገባ ንገሩኝ' : '🔔  Tell me about new arrivals', 'news:on');
    await ctx.reply(am ? 'እንኳን ወደ Hikma Men’s Fashion በደህና መጡ።' : 'Welcome to Hikma Men’s Fashion.', { reply_markup: kb });
  });

  // New-arrival announcements: opt in / out (button, /news, /stop)
  const setNews = async (ctx: Context, on: boolean) => {
    if (!ctx.from) return;
    const { setNewsOptIn } = await import('./broadcast'); // lazy: avoids a circular import
    await setNewsOptIn(ctx.from, on);
    const am = isAm(ctx);
    const text = on
      ? am
        ? '✅ አዲስ ዕቃ ሲገባ እናሳውቅዎታለን። ለማቆም /stop'
        : '✅ You’ll get a message when new items arrive. Turn off anytime: /stop'
      : am
        ? 'የአዲስ ዕቃ መልዕክቶች ቆመዋል። እንደገና ለመጀመር /news'
        : 'New-arrival messages are off. Turn them back on: /news';
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: on ? '✅' : 'OK' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    }
    await ctx.reply(text);
  };
  bot.callbackQuery('news:on', (ctx) => setNews(ctx, true));
  bot.command('news', (ctx) => (ctx.chat.type === 'private' ? setNews(ctx, true) : undefined));
  bot.command('stop', (ctx) => (ctx.chat.type === 'private' ? setNews(ctx, false) : undefined));

  bot.command('orders', async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) return;
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    const orders = user
      ? await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 5 })
      : [];
    if (!orders.length) {
      await ctx.reply(isAm(ctx) ? 'እስካሁን ትዕዛዝ የለዎትም።' : 'You have no orders yet.', {
        reply_markup: new InlineKeyboard().webApp('🛍  Shop', shopUrl('/')),
      });
      return;
    }
    const kb = new InlineKeyboard();
    for (const o of orders) kb.webApp(`${o.orderNumber} · ${o.total.toLocaleString()} ETB`, shopUrl(`/orders/${o.orderNumber}`)).row();
    await ctx.reply(isAm(ctx) ? 'የቅርብ ጊዜ ትዕዛዞችዎ' : 'Your recent orders', { reply_markup: kb });
  });

  bot.command('help', async (ctx) => {
    const s = await prisma.settings.findUnique({ where: { id: 'default' } });
    await ctx.reply(
      [`📞 ${s?.phone ?? ''}`, `📩 @${s?.telegramInbox ?? ''}`, `📍 ${isAm(ctx) ? s?.addressAm : s?.addressEn}`].join('\n'),
    );
  });

  // "/link CODE" connects a chat to the shop. grammY delivers commands from private chats, groups AND
  // channel posts to this one handler, so the purpose is decided by where it was sent:
  //   channel              → product posts go to this channel   (bot must be a channel admin)
  //   private chat / group → new-order alerts go here
  // Today's summary on demand — only in the order-alerts chat or for staff in private
  bot.command('report', async (ctx) => {
    if (!ctx.from) return;
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    const inAlertsChat = settings?.adminChatId === String(ctx.chat.id);
    const staff = await prisma.user.findFirst({
      where: { telegramId: BigInt(ctx.from.id), role: { in: ['OWNER', 'ADMIN'] }, isActive: true },
    });
    if (!inAlertsChat && !(ctx.chat.type === 'private' && staff)) return;
    const { sendDailyReport } = await import('../reports/dailyReport'); // lazy: avoids a circular import
    await sendDailyReport(String(ctx.chat.id));
  });

  bot.command('link', async (ctx) => {
    const isChannel = ctx.chat.type === 'channel';
    const result = await consumeLinkCode(String(ctx.match ?? ''), isChannel ? 'channel' : 'admin');

    if (isChannel) {
      // Keep the channel clean: remove the /link post, show a short note that removes itself
      const postId = ctx.channelPost?.message_id;
      if (postId) await ctx.api.deleteMessage(ctx.chat.id, postId).catch(() => undefined);
      let text: string;
      if (result.ok) {
        await prisma.settings.upsert({
          where: { id: 'default' },
          create: { id: 'default', channelChatId: String(ctx.chat.id) },
          update: { channelChatId: String(ctx.chat.id) },
        });
        text = '✅ Channel connected to the Hikma shop.';
      } else if (result.reason === 'wrong_place') {
        text = 'ℹ️ That code is for order alerts. Send it to the bot in a private chat instead.';
      } else {
        text = '⚠️ That code is wrong or expired. Get a new one in Admin → Settings → Telegram.';
      }
      const note = await ctx.api.sendMessage(ctx.chat.id, text).catch(() => null);
      if (note) setTimeout(() => void ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => undefined), 15_000);
      return;
    }

    if (!result.ok) {
      await ctx.reply(
        result.reason === 'wrong_place'
          ? 'ℹ️ That code is for the channel. Post it in the channel (the bot must be a channel admin). The code still works.'
          : '⚠️ That code is wrong or expired. Get a new one in Admin → Settings → Telegram.',
      );
      return;
    }
    await prisma.settings.upsert({
      where: { id: 'default' },
      create: { id: 'default', adminChatId: String(ctx.chat.id) },
      update: { adminChatId: String(ctx.chat.id) },
    });
    await ctx.reply(ctx.chat.type === 'private' ? '✅ New orders will now arrive in this chat.' : '✅ This group will now receive new orders.');
  });


  // Channel auto-import: photo posts in the linked channel are collected and become draft products.
  // (/link posts never get here — the command handler above handles them and stops the chain.)
  bot.on('channel_post', async (ctx) => {
    const input = toPostInput(ctx.channelPost);
    if (input) await collectChannelPost(input);
  });

  // Admin order actions from the group card: "o:<orderId>:<action>"
  bot.callbackQuery(/^o:([a-z0-9]+):([A-Za-z_]+)$/, async (ctx) => {
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    if (!settings?.adminChatId || String(ctx.chat?.id) !== settings.adminChatId) {
      await ctx.answerCallbackQuery({ text: 'Not allowed here' });
      return;
    }
    const [, orderId, action] = ctx.match;
    const actor = ctx.from ? await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } }) : null;
    const who = ctx.from?.first_name ?? 'Admin';
    // Imported lazily to avoid a circular import (orders.service → notify → bot)
    const { changeStatus, reviewPayment } = await import('../orders/orders.service');
    const { refreshAdminCards } = await import('./notify');
    try {
      const actorId = actor && actor.role !== 'CUSTOMER' ? actor.id : null;
      if (action === 'verify') await reviewPayment(orderId!, actorId, { approve: true });
      else if (action === 'reject') await reviewPayment(orderId!, actorId, { approve: false });
      else if (action === 'DELIVERED') throw Object.assign(new Error('Delivery is confirmed with the customer’s code (driver) — or in the admin'), { code: 'NEEDS_CODE' });
      else await changeStatus(orderId!, action as OrderStatus, actorId, undefined);
      await ctx.answerCallbackQuery({ text: '✅ Done' });
      await refreshAdminCards(orderId!, `Last action by ${who}`);
      const { logActivity } = await import('../admin/activity');
      const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
      void logActivity({
        actorId,
        actorName: actor?.fullName ?? who,
        action: action === 'verify' || action === 'reject' ? 'order.payment' : 'order.status',
        summary: `${o?.orderNumber ?? 'Order'} → ${action === 'verify' ? 'payment confirmed' : action === 'reject' ? 'payment rejected' : String(action).toLowerCase().replace(/_/g, ' ')} (Telegram)`,
        entity: 'order',
        entityId: orderId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed';
      const stale = (err as { code?: string }).code === 'STALE';
      // A stale button (order already changed elsewhere): explain briefly and fix the card
      await ctx.answerCallbackQuery({ text: stale ? `ℹ️ ${message}` : message.slice(0, 190), show_alert: !stale });
      if (stale) await refreshAdminCards(orderId!);
    }
  });
}

/** Downloads a photo the bot received (Bot API file download; files up to 20 MB). */
export async function telegramDownload(fileId: string): Promise<Buffer> {
  if (!bot) throw new Error('Bot not configured');
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram returned no file path');
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Photo download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Background worker that turns collected channel posts into drafts. No-op without a bot. */
export function startChannelImportWorker(onDraft: Parameters<typeof processReadyImports>[1]) {
  if (!bot) return () => undefined;
  let running = false;
  const id = setInterval(() => {
    if (running) return;
    running = true;
    processReadyImports(telegramDownload, onDraft)
      .catch((err) => logger.warn({ err }, 'channel import worker error'))
      .finally(() => (running = false));
  }, 3000);
  return () => clearInterval(id);
}

export function telegramWebhook() {
  if (!bot) return null;
  return webhookCallback(bot, 'express', { secretToken: env.TELEGRAM_WEBHOOK_SECRET });
}

export async function startPollingIfEnabled() {
  if (!bot || !env.TELEGRAM_POLLING) return;
  logger.warn('Telegram bot running in polling mode (development)');
  void bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'] });
}

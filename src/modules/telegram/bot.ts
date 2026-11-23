import { Bot, InlineKeyboard, webhookCallback, type Context } from 'grammy';
import type { OrderStatus } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { consumeLinkCode } from './linkCodes';
import { confirmLoginToken } from '../auth/botLogin';

/** The bot exists only when a token is configured; everything else degrades gracefully. */
export const bot: Bot | null = env.TELEGRAM_BOT_TOKEN ? new Bot(env.TELEGRAM_BOT_TOKEN) : null;

export function shopUrl(path = '/') {
  return `${env.clientUrl}${path}`;
}

/** Direct Mini App link (works in channels, where web_app buttons are not allowed). */
export function miniAppLink(startParam?: string) {
  const base = `https://t.me/${env.TELEGRAM_BOT_USERNAME}/${env.TELEGRAM_MINIAPP_SHORT_NAME}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
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
      const ok = confirmLoginToken(payload.slice(6), {
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
    await ctx.reply(am ? 'እንኳን ወደ Hikma Men’s Fashion በደህና መጡ።' : 'Welcome to Hikma Men’s Fashion.', {
      reply_markup: new InlineKeyboard().webApp(am ? '🛍  ሱቁን ይክፈቱ' : '🛍  Open the shop', shopUrl(path)),
    });
  });

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

  // Owner links the admin group: dashboard shows a code, owner sends "/link CODE" in the group.
  bot.command('link', async (ctx) => {
    const purpose = consumeLinkCode(String(ctx.match ?? '').trim().toUpperCase());
    if (purpose !== 'admin' || ctx.chat.type === 'private') return;
    await prisma.settings.update({ where: { id: 'default' }, data: { adminChatId: String(ctx.chat.id) } });
    await ctx.reply('✅ This group will now receive new orders.');
  });

  // Owner links the channel: posts "/link CODE" in the channel; the bot must be a channel admin.
  bot.on('channel_post:text', async (ctx) => {
    const text = ctx.channelPost.text.trim();
    if (!text.startsWith('/link ')) return;
    const purpose = consumeLinkCode(text.slice(6).trim().toUpperCase());
    if (purpose !== 'channel') return;
    await prisma.settings.update({ where: { id: 'default' }, data: { channelChatId: String(ctx.chat.id) } });
    await ctx.api.deleteMessage(ctx.chat.id, ctx.channelPost.message_id).catch(() => undefined);
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
    try {
      // Imported lazily to avoid a circular import (orders.service → notify → bot)
      const { changeStatus, reviewPayment } = await import('../orders/orders.service');
      const actorId = actor && actor.role !== 'CUSTOMER' ? actor.id : null;
      if (action === 'verify') await reviewPayment(orderId!, actorId, { approve: true });
      else if (action === 'reject') await reviewPayment(orderId!, actorId, { approve: false });
      else await changeStatus(orderId!, action as OrderStatus, actorId, undefined);
      await ctx.answerCallbackQuery({ text: '✅ Done' });
      const { refreshAdminCard } = await import('./notify');
      await refreshAdminCard(orderId!, ctx, who);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed';
      await ctx.answerCallbackQuery({ text: message.slice(0, 190), show_alert: true });
    }
  });
}

export function telegramWebhook() {
  if (!bot) return null;
  return webhookCallback(bot, 'express', { secretToken: env.TELEGRAM_WEBHOOK_SECRET });
}

export async function startPollingIfEnabled() {
  if (!bot || !env.TELEGRAM_POLLING) return;
  logger.warn('Telegram bot running in polling mode (development)');
  void bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query', 'channel_post'] });
}

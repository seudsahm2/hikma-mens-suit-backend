/**
 * Verified phone numbers through Telegram's "Share my contact".
 * Telegram puts the sharer's own user id in contact.user_id — when it equals the sender, the number
 * really belongs to this Telegram account (a typed number, or one forwarded from someone else, never counts).
 * Mini App: Telegram.WebApp.requestContact() sends this same message to the bot.
 * Website: t.me/<bot>?start=phone → the bot shows a one-tap "📱 Share my phone" button.
 */
import { normalizeEthiopianPhone } from '../../lib/phone';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot } from './bot';

export const SHARE_PHONE_BUTTON = '📱 Share my phone';

export async function askForPhone(ctx: { reply: (t: string, e?: object) => Promise<unknown> }, am: boolean) {
  await ctx.reply(am ? 'ስልክ ቁጥርዎን ለማረጋገጥ ከታች ያለውን ቁልፍ ይንኩ።' : 'Tap the button below to confirm your phone number.', {
    reply_markup: { keyboard: [[{ text: SHARE_PHONE_BUTTON, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
  });
}

if (bot) {
  bot.on('message:contact', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const c = ctx.message.contact;
    // Only the sender's OWN contact counts
    if (!c.user_id || c.user_id !== ctx.from.id) {
      await ctx.reply('Please share your own contact with the button — not someone else’s.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    const phone = normalizeEthiopianPhone(c.phone_number); // handles +251…, 251…, 09…
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      await ctx.reply('Open the shop once (the Shop button), then share again.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    if (!phone) {
      await ctx.reply('That number isn’t an Ethiopian mobile number — you can type your number at checkout.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    // Another account already holds this number (phone is unique): keep theirs, don't steal it
    const holder = await prisma.user.findUnique({ where: { phone } });
    if (holder && holder.id !== user.id) {
      logger.warn({ userId: user.id }, 'shared phone already used by another account');
      await ctx.reply('This number is already used by another account. Please contact the shop.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { phone, phoneVerifiedAt: new Date() } });
    await ctx.reply(`✅ ${phone} confirmed. You can go back to the shop.`, { reply_markup: { remove_keyboard: true } });
  });
}

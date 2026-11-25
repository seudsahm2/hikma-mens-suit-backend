/**
 * Everything the bot says to a driver goes through here:
 *  - into the driver's own "🛵 Deliveries" topic when the bot has threaded mode (BotFather → Bot
 *    Settings → Threaded mode) — so delivery messages never mix with the driver's own shopping messages;
 *  - otherwise into the normal chat, marked 🛵.
 * The driver always has three buttons at the bottom: 🟢 Online · ⚪ Offline · 📍 Send my location.
 */
import type { Driver } from '@prisma/client';
import type { ReplyKeyboardMarkup } from 'grammy/types';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot } from '../telegram/bot';

export const BTN_ONLINE = '🟢 Online';
export const BTN_OFFLINE = '⚪ Offline';
export const BTN_LIVE = '📡 Share live location';
/** Live location only — a one-time pin goes stale the moment the driver moves. */
export const LIVE_HOWTO = [
  '📡 <b>Share your LIVE location</b> (once a day, 3 taps):',
  '',
  '1️⃣ Tap 📎 (the paperclip, next to the message box)',
  '2️⃣ Tap <b>Location</b>',
  '3️⃣ Tap <b>Share My Live Location</b> → choose <b>8 hours</b>',
  '',
  'The shop then always sees where you are and sends you the nearest jobs. ✅',
].join(String.fromCharCode(10));
export const DRIVER_BUTTONS = [BTN_ONLINE, BTN_OFFLINE, BTN_LIVE];

export function driverKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: BTN_ONLINE }, { text: BTN_OFFLINE }], [{ text: BTN_LIVE }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Deliveries',
  };
}

/** Creates the driver's "🛵 Deliveries" topic once (if the bot has threaded mode). */
export async function ensureDriverTopic(driver: Pick<Driver, 'id' | 'telegramId' | 'topicId'>): Promise<number | null> {
  if (!bot || !driver.telegramId) return null;
  if (driver.topicId) return driver.topicId;
  try {
    // Bot API: topics in private chats (works when threaded mode is on for the bot)
    const topic = (await bot.api.raw.createForumTopic({ chat_id: Number(driver.telegramId), name: '🛵 Deliveries' })) as { message_thread_id: number };
    await prisma.driver.update({ where: { id: driver.id }, data: { topicId: topic.message_thread_id } });
    return topic.message_thread_id;
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'driver topic not available — using the main chat');
    return null;
  }
}

type Extra = Record<string, unknown>;

/** Sends to the driver's topic (or the main chat). Never throws. */
export async function driverSend(driver: Pick<Driver, 'id' | 'telegramId' | 'topicId'>, text: string, extra: Extra = {}) {
  if (!bot || !driver.telegramId) return null;
  const chat = Number(driver.telegramId);
  const topicId = driver.topicId ?? null;
  try {
    return await bot.api.sendMessage(chat, topicId ? text : `🛵 ${text}`, { ...(topicId ? { message_thread_id: topicId } : {}), ...extra });
  } catch (err) {
    // Topic deleted by the driver: forget it and use the main chat
    if (topicId && /thread|topic/i.test((err as Error).message)) {
      await prisma.driver.update({ where: { id: driver.id }, data: { topicId: null } }).catch(() => undefined);
      return bot.api.sendMessage(chat, `🛵 ${text}`, extra).catch(() => null);
    }
    logger.warn({ err: (err as Error).message }, 'driver message not delivered');
    return null;
  }
}

export async function driverSendLocation(driver: Pick<Driver, 'id' | 'telegramId' | 'topicId'>, lat: number, lng: number) {
  if (!bot || !driver.telegramId) return;
  await bot.api.sendLocation(Number(driver.telegramId), lat, lng, driver.topicId ? { message_thread_id: driver.topicId } : {}).catch(() => undefined);
}

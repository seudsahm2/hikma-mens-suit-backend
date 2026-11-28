/**
 * Everything the bot sends directly to the shop owner (backups, password resets, /report DMs)
 * goes into the owner's own "👔 Shop · Owner" topic when the bot has threaded mode — so owner
 * operations never mix with personal shopping messages when ownerCanOrder is enabled.
 */
import type { User } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot } from './bot';

/** Creates the owner's "👔 Shop · Owner" topic once (if the bot has threaded mode). */
export async function ensureOwnerTopic(user: Pick<User, 'id' | 'staffTelegramId' | 'staffTopicId'>): Promise<number | null> {
  if (!bot || !user.staffTelegramId) return null;
  if (user.staffTopicId) return user.staffTopicId;
  try {
    const topic = (await bot.api.raw.createForumTopic({ chat_id: Number(user.staffTelegramId), name: '👔 Shop · Owner' })) as { message_thread_id: number };
    await prisma.user.update({ where: { id: user.id }, data: { staffTopicId: topic.message_thread_id } });
    return topic.message_thread_id;
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'owner topic not available — using the main chat');
    return null;
  }
}

/** Resolves the owner's topic id for a given Telegram chat id (if that chat belongs to an active OWNER). */
export async function getOwnerTopicId(chatId: string | number | bigint): Promise<number | undefined> {
  if (!bot) return undefined;
  let id: bigint;
  try {
    id = BigInt(chatId);
  } catch {
    return undefined;
  }
  const owner = await prisma.user.findFirst({
    where: { role: 'OWNER', isActive: true, staffTelegramId: id },
    select: { id: true, staffTelegramId: true, staffTopicId: true },
  });
  if (!owner) return undefined;
  return (await ensureOwnerTopic(owner)) ?? undefined;
}

type Extra = Record<string, unknown>;

/** Sends to the owner's topic (or falls back to the main chat). Never throws. */
export async function ownerSend(user: Pick<User, 'id' | 'staffTelegramId' | 'staffTopicId'>, text: string, extra: Extra = {}) {
  if (!bot || !user.staffTelegramId) return null;
  const chat = Number(user.staffTelegramId);
  const topicId = await ensureOwnerTopic(user);
  try {
    return await bot.api.sendMessage(chat, text, { ...(topicId ? { message_thread_id: topicId } : {}), ...extra });
  } catch (err) {
    // Topic deleted by the owner: forget it and fall back to the main chat
    if (topicId && /thread|topic/i.test((err as Error).message)) {
      await prisma.user.update({ where: { id: user.id }, data: { staffTopicId: null } }).catch(() => undefined);
      return bot.api.sendMessage(chat, text, extra).catch(() => null);
    }
    logger.warn({ err: (err as Error).message }, 'owner message not delivered');
    return null;
  }
}

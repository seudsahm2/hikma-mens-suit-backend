import type { Message } from 'grammy/types';
import { Prisma, type ChannelImport } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { randomSuffix, slugify } from '../../lib/slug';
import { saveImage } from '../../lib/storage';
import { BRANDS, parseCaption } from '../catalog/captionParser';

/**
 * Channel auto-import: new posts in the linked channel become DRAFT products.
 *
 *   webhook update ──► collectChannelPost()  — stores the photo/caption in ChannelImport (DB)
 *   worker (every 3 s) ──► processReadyImports() — once a post has been quiet for QUIET_MS, downloads
 *                                                  its photos and creates the draft
 *
 * Albums arrive as one update per photo (same media_group_id, caption on one of them), which is why
 * posts are collected first. Everything is in the database, so restarts or Render sleep lose nothing.
 */
export const QUIET_MS = 6_000;
const MAX_ATTEMPTS = 3;
const MAX_PHOTOS = 10;

export interface ChannelPostInput {
  chatId: string;
  messageId: number;
  mediaGroupId?: string;
  caption?: string;
  fileId?: string;
  date: number; // unix seconds
}

/** Extracts what we need from a channel post. Returns null for posts without a photo. */
export function toPostInput(msg: Message): ChannelPostInput | null {
  // Largest size is last; also accept images sent "as file"
  const photo = msg.photo?.at(-1)?.file_id ?? (msg.document?.mime_type?.startsWith('image/') ? msg.document.file_id : undefined);
  if (!photo) return null;
  return {
    chatId: String(msg.chat.id),
    messageId: msg.message_id,
    mediaGroupId: msg.media_group_id,
    caption: msg.caption ?? undefined,
    fileId: photo,
    date: msg.date,
  };
}

const keyFor = (chatId: string, messageId: number, mediaGroupId?: string) =>
  mediaGroupId ? `${chatId}:g${mediaGroupId}` : `${chatId}:m${messageId}`;

/** Stores one channel post (or one photo of an album). Ignores other chats and our own posts. */
export async function collectChannelPost(input: ChannelPostInput): Promise<'collected' | 'ignored'> {
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!settings?.channelAutoImport || settings.channelChatId !== input.chatId) return 'ignored';

  const id = keyFor(input.chatId, input.messageId, input.mediaGroupId);
  const existing = await prisma.channelImport.findUnique({ where: { id } });
  if (existing && existing.status !== 'collecting') return 'ignored'; // own post, or already handled

  const create = async () =>
    prisma.channelImport.create({
      data: {
        id,
        chatId: input.chatId,
        messageIds: [input.messageId],
        fileIds: input.fileId ? [input.fileId] : [],
        caption: input.caption ?? '',
        postedAt: new Date(input.date * 1000),
      },
    });
  const append = async () =>
    prisma.channelImport.update({
      where: { id },
      data: {
        messageIds: { push: input.messageId },
        ...(input.fileId ? { fileIds: { push: input.fileId } } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
      },
    });

  if (!existing) {
    try {
      await create();
      return 'collected';
    } catch (err) {
      // Two photos of the same album arrived at the same moment: the other one created it first
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  await append();
  return 'collected';
}

/** Marks posts the shop itself published ("Post to channel") so they are never imported back. */
export async function recordOwnPost(chatId: string, messageIds: number[], mediaGroupId?: string) {
  const ids = mediaGroupId ? [keyFor(chatId, 0, mediaGroupId)] : messageIds.map((m) => keyFor(chatId, m));
  for (const id of ids) {
    await prisma.channelImport
      .upsert({
        where: { id },
        create: { id, chatId, messageIds, fileIds: [], postedAt: new Date(), status: 'own' },
        update: { status: 'own' },
      })
      .catch((err) => logger.warn({ err }, 'could not record own channel post'));
  }
}

export type Downloader = (fileId: string) => Promise<Buffer>;
export type DraftCreated = { productId: string; name: string; price: number | null; photos: number };

/** Turns one collected post into a draft product. */
async function importOne(row: ChannelImport, download: Downloader): Promise<{ status: 'done' | 'skipped'; note: string; draft?: DraftCreated }> {
  if (!row.fileIds.length) return { status: 'skipped', note: 'no photos' };
  if (!row.caption.trim()) return { status: 'skipped', note: 'no caption' };
  const parsed = parseCaption(row.caption);
  if (!parsed.isProduct) return { status: 'skipped', note: 'not a product (greeting/announcement)' };

  const category =
    (await prisma.category.findUnique({ where: { slug: parsed.categorySlug } })) ?? (await prisma.category.findUnique({ where: { slug: 'shirts' } }));
  if (!category) throw new Error('No categories — run the seed');

  // Photos first (outside any transaction); the product and its images are then created in one call
  const images: { key: string; width: number | null; height: number | null; sortOrder: number; alt: string }[] = [];
  for (const fileId of row.fileIds.slice(0, MAX_PHOTOS)) {
    const saved = await saveImage(await download(fileId), 'products');
    images.push({ key: saved.key, width: saved.width, height: saved.height, sortOrder: images.length, alt: parsed.name });
  }

  const brandName = parsed.brand ?? BRANDS.find(([, re]) => re.test(parsed.name))?.[0] ?? null;
  const brand = brandName
    ? await prisma.brand.upsert({ where: { slug: slugify(brandName) }, create: { slug: slugify(brandName), name: brandName }, update: {} })
    : null;
  let name = parsed.name;
  if (brandName && name.toLowerCase().startsWith(brandName.toLowerCase() + ' ')) name = name.slice(brandName.length).trim();
  const sizes = parsed.sizes.length ? parsed.sizes : category.sizes.length ? category.sizes.slice(1, Math.min(category.sizes.length - 1, 6)) : [''];

  const product = await prisma.product.create({
    data: {
      slug: `${slugify(name) || 'item'}-${randomSuffix(5)}`,
      importRef: `tgc-${row.id}`,
      nameEn: name,
      categoryId: category.id,
      brandId: brand?.id,
      origin: parsed.origin,
      basePrice: parsed.price ?? 0,
      status: 'DRAFT',
      isNewArrival: true,
      tags: ['channel'],
      createdAt: row.postedAt,
      images: { create: images },
      variants: { create: sizes.map((size, i) => ({ sku: `TGC${row.messageIds[0]}-${i}-${randomSuffix(3).toUpperCase()}`, size, stock: 0 })) },
    },
  });
  return { status: 'done', note: `draft ${product.id}`, draft: { productId: product.id, name, price: parsed.price, photos: images.length } };
}

/**
 * Processes posts that have been quiet for QUIET_MS. Safe to run on several servers at once: each row
 * is claimed with a conditional update before work starts.
 */
export async function processReadyImports(
  download: Downloader,
  onDraft?: (draft: DraftCreated) => Promise<void> | void,
  now = Date.now(),
): Promise<number> {
  const ready = await prisma.channelImport.findMany({
    where: { status: 'collecting', updatedAt: { lt: new Date(now - QUIET_MS) } },
    orderBy: { updatedAt: 'asc' },
    take: 5,
  });
  let handled = 0;
  for (const row of ready) {
    const claim = await prisma.channelImport.updateMany({
      where: { id: row.id, status: 'collecting' },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // another worker took it
    try {
      const result = await importOne(row, download);
      await prisma.channelImport.update({
        where: { id: row.id },
        data: { status: result.status, note: result.note, productId: result.draft?.productId ?? null },
      });
      if (result.draft) {
        logger.info({ productId: result.draft.productId, name: result.draft.name }, 'channel post imported as draft');
        await Promise.resolve(onDraft?.(result.draft)).catch((err) => logger.warn({ err }, 'draft notification failed'));
      }
      handled++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, id: row.id, attempts }, 'channel import failed');
      await prisma.channelImport.update({
        where: { id: row.id },
        // back to "collecting" → retried after the quiet period; give up after MAX_ATTEMPTS
        data: { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'collecting', note: message.slice(0, 300) },
      });
    }
  }
  return handled;
}

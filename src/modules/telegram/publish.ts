import { InlineKeyboard } from 'grammy';
import type { InputMediaPhoto } from 'grammy/types';
import { prisma } from '../../lib/prisma';
import { HttpError, notFound } from '../../lib/http';
import { getSettings } from '../settings/settings.service';
import { bot, miniAppLink, shopUrl } from './bot';
import { buildCaption } from './captions';
import { telegramPhoto } from './media';

async function captionFor(productId: string) {
  const [p, settings, addis] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      include: { category: true, brand: true, images: { orderBy: { sortOrder: 'asc' } }, variants: { where: { isActive: true } } },
    }),
    getSettings(),
    prisma.deliveryOption.findUnique({ where: { id: 'addis' } }),
  ]);
  if (!p) throw notFound('Product not found');
  const sizeOrder = p.category.sizes;
  const sizes = [...new Set(p.variants.filter((v) => v.stock > 0 && v.size).map((v) => v.size))].sort(
    (a, b) => (sizeOrder.indexOf(a) + 1 || 999) - (sizeOrder.indexOf(b) + 1 || 999),
  );
  const prices = p.variants.map((v) => v.price ?? p.basePrice);
  const caption = buildCaption({
    kind: p.category.kind,
    nameEn: p.nameEn,
    nameAm: p.nameAm,
    brand: p.brand?.name,
    price: prices.length ? Math.min(...prices) : p.basePrice,
    origin: p.origin,
    sizes,
    volumeMl: p.volumeMl,
    concentration: p.concentration,
    freeDelivery: Boolean(addis?.isEnabled && addis.fee === 0),
    inbox: settings.telegramInbox,
    phone: settings.phone,
    addressAm: settings.addressAm,
  });
  return { product: p, caption, settings };
}

export async function previewCaption(productId: string) {
  return (await captionFor(productId)).caption;
}

/** Posts a product to the linked Telegram channel with an "Order" button. */
export async function publishToChannel(productId: string, captionOverride?: string) {
  if (!bot) throw new HttpError(503, 'Telegram bot is not configured', 'TELEGRAM_DISABLED');
  const { product, caption, settings } = await captionFor(productId);
  if (!settings.channelChatId) throw new HttpError(409, 'Link your Telegram channel in Settings first', 'NO_CHANNEL');
  if (product.status !== 'ACTIVE') throw new HttpError(409, 'Activate the product before publishing', 'NOT_ACTIVE');
  if (!product.images.length) throw new HttpError(409, 'Add at least one photo', 'NO_IMAGES');

  const text = (captionOverride?.trim() || caption).slice(0, 1024);
  const orderUrl = miniAppLink(`p_${product.slug}`);
  const keyboard = new InlineKeyboard().url('🛒  Order now', orderUrl).url('🌐  Website', shopUrl(`/p/${product.slug}`));
  const chat = settings.channelChatId;
  const photos = product.images.slice(0, 10);

  let messageId: number;
  if (photos.length === 1) {
    const msg = await bot.api.sendPhoto(chat, telegramPhoto(photos[0]!.key), { caption: text, reply_markup: keyboard });
    messageId = msg.message_id;
  } else {
    // Albums can't carry buttons, so the button goes in a short follow-up message.
    const media: InputMediaPhoto[] = photos.map((img, i) => ({
      type: 'photo',
      media: telegramPhoto(img.key) as InputMediaPhoto['media'],
      ...(i === 0 ? { caption: text } : {}),
    }));
    const msgs = await bot.api.sendMediaGroup(chat, media);
    messageId = msgs[0]!.message_id;
    await bot.api.sendMessage(chat, '👇', { reply_markup: keyboard, reply_parameters: { message_id: messageId } });
  }

  // Remember the post link (public channels have a username; private ones use /c/<id>)
  const chatInfo = await bot.api.getChat(chat).catch(() => null);
  const username = chatInfo && 'username' in chatInfo ? chatInfo.username : undefined;
  const postUrl = username ? `https://t.me/${username}/${messageId}` : `https://t.me/c/${chat.replace(/^-100/, '')}/${messageId}`;
  await prisma.product.update({ where: { id: productId }, data: { telegramPostUrl: postUrl } });
  return { postUrl };
}

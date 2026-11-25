import { InlineKeyboard } from 'grammy';
import type { DeliveryOffer, Driver, Order, OrderItem, OrderStatus, User } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot, shopUrl } from './bot';
import { birr, escapeHtml, telegramPhoto } from './media';
import { canReviewPayment, isFinalStatus, nextSteps } from '../orders/rules';

export type OrderEventKind = 'placed' | 'payment_submitted' | 'payment_verified' | 'payment_rejected' | 'status';

type FullOrder = Order & {
  items: OrderItem[];
  user: User | null;
  /** latest driver offer (delivery orders), for the card's driver line and buttons */
  deliveryOffers?: (DeliveryOffer & { driver: Driver })[];
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '🕓 Pending',
  CONFIRMED: '✅ Confirmed',
  PACKING: '📦 Packing',
  OUT_FOR_DELIVERY: '🚚 Out for delivery',
  DELIVERED: '🏁 Delivered',
  PICKED_UP: '🏁 Picked up',
  CANCELLED: '✖️ Cancelled',
};

const PAYMENT_LABEL: Record<Order['paymentStatus'], string> = {
  UNPAID: 'Not paid',
  SUBMITTED: '🔎 Proof submitted — check it',
  PARTIAL: '💵 Deposit paid',
  PAID: '💵 Paid',
  REJECTED: '⚠️ Rejected',
};

// ─── Admin group card ────────────────────────────────────

function adminCardText(o: FullOrder, footer?: string) {
  const lines = [
    `<b>${escapeHtml(o.orderNumber)}</b> · ${STATUS_LABEL[o.status]}`,
    '',
    ...o.items.map(
      (i) =>
        `• ${escapeHtml(i.productName)}${i.size ? ` · ${escapeHtml(i.size)}` : ''}${i.color ? ` · ${escapeHtml(i.color)}` : ''} × ${i.quantity}`,
    ),
    '',
    o.discountTotal > 0
      ? `🏷 Discounts: −${birr(o.discountTotal)} (${((o.discounts as { label: string }[] | null) ?? []).map((d) => escapeHtml(d.label)).join(', ')})`
      : '',
    o.giftNote ? `🎁 <b>Add gift:</b> ${escapeHtml(o.giftNote)}` : '',
    `<b>Total:</b> ${birr(o.total)}${o.deliveryFee === null ? ' + delivery (by phone)' : ''}`,
    `<b>Due now:</b> ${birr(o.amountDue)}${o.isDeposit ? ' (deposit)' : ''}`,
    `<b>Payment:</b> ${escapeHtml(o.paymentLabel ?? '-')} — ${PAYMENT_LABEL[o.paymentStatus]}`,
    o.transactionRef ? `<b>Ref:</b> <code>${escapeHtml(o.transactionRef)}</code>` : '',
    driverLine(o),
    o.cancelAt
      ? `⏳ <b>Cancelling at ${o.cancelAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Addis_Ababa' })}</b> — nobody is told until then. Tapped by mistake? ↩️ Undo cancel`
      : '',
    '',
    `👤 ${escapeHtml(o.customerName)} · <a href="tel:${o.customerPhone}">${o.customerPhone}</a>${
      o.user?.telegramUsername ? ` · @${escapeHtml(o.user.telegramUsername)}` : ''
    }`,
    `📍 ${escapeHtml(o.deliveryLabel)}${[o.city, o.area, o.landmark].filter(Boolean).length ? ` — ${escapeHtml([o.city, o.area, o.landmark].filter(Boolean).join(', '))}` : ''}`,
    o.lat !== null && o.lng !== null ? `🗺 <a href="https://maps.google.com/?q=${o.lat},${o.lng}">Map pin</a>` : '',
    o.note ? `📝 ${escapeHtml(o.note)}` : '',
    o.paymentCheck ? escapeHtml(o.paymentCheck) : '',
    footer ? `\n<i>${escapeHtml(footer)}</i>` : '',
  ];
  return lines.filter((l, idx, arr) => l !== '' || arr[idx - 1] !== '').join('\n').trim();
}

/** Buttons offered on a card — computed from the same rules the server enforces. */
/**
 * Exactly ONE next step — the same flow as the website and the Mini App:
 *   Pending: confirm the payment (or "Confirm" for cash) → Confirmed: Packing →
 *   Packing: delivery → Find nearest driver / (driver accepted) Handed over; pickup → Picked up →
 *   On the way: nothing to tap — it becomes Delivered when the driver types the customer's code.
 */
function adminKeyboard(o: FullOrder) {
  const kb = new InlineKeyboard();
  if (isFinalStatus(o.status)) return kb;
  const id = o.id;
  const pickup = o.deliveryOptionId === 'pickup';
  const offer = o.deliveryOffers?.[0];
  const activeOffer = offer && (offer.status === 'offered' || offer.status === 'accepted') ? offer : null;

  // Cancel counting down: only Undo / Cancel now until it happens
  if (o.cancelAt) return kb.text('↩️ Undo cancel', `o:${id}:undocancel`).text('✖️ Cancel now', `o:${id}:cancelnow`);

  if (o.status === 'PENDING') {
    if (canReviewPayment(o.status, o.paymentStatus) && o.paymentMethodId !== 'cash') {
      kb.text('✅ Payment OK', `o:${id}:verify`);
      if (o.paymentStatus === 'SUBMITTED') kb.text('⚠️ Reject', `o:${id}:ask_reject`);
    } else {
      kb.text('✅ Confirm order', `o:${id}:CONFIRMED`);
    }
    kb.row();
  } else if (o.status === 'CONFIRMED') {
    kb.text('📦 Packing', `o:${id}:PACKING`).row();
  } else if (o.status === 'PACKING') {
    if (pickup) kb.text('🏁 Picked up', `o:${id}:ask_PICKED_UP`).row();
    else if (activeOffer?.status === 'accepted') kb.text(`📦 Handed to ${activeOffer.driver.name.split(' ')[0]}`, `o:${id}:ask_handover`).row();
    else if (activeOffer) kb.text('↩️ Cancel driver', `o:${id}:ask_undispatch`).row();
    else kb.text('🛵 Choose a driver', `o:${id}:pick`).row();
  }
  // Out for delivery: no button — Delivered needs the customer's code (driver) or the admin's confirmation
  kb.text('✖️ Cancel', `o:${id}:CANCELLED`);
  return kb;
}

/** "🛵 Waiting for Nati…" / "🛵 Nati accepted — ~15 min" / "🛵 With Nati" */
function driverLine(o: FullOrder) {
  if (o.deliveryOptionId === 'pickup' || isFinalStatus(o.status)) return '';
  const offer = o.deliveryOffers?.[0];
  if (o.status === 'OUT_FOR_DELIVERY' && offer) return `🛵 With <b>${escapeHtml(offer.driver.name)}</b> · 🔐 delivered when the customer’s code is confirmed`;
  if (!offer) return '';
  if (offer.status === 'offered') {
    const by = offer.expiresAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Addis_Ababa' });
    return `🛵 Waiting for <b>${escapeHtml(offer.driver.name)}</b> — ⏳ answer by <b>${by}</b> (5 min), then ${offer.auto ? 'the next nearest driver gets it' : 'choose another driver'}`;
  }
  if (offer.status === 'accepted') return `🛵 <b>${escapeHtml(offer.driver.name)}</b> accepted — at the shop in ~${offer.etaMinutes ?? '?'} min`;
  if (offer.status === 'declined' || offer.status === 'expired') return `🛵 ${escapeHtml(offer.driver.name)} ${offer.status === 'declined' ? 'can’t take it' : 'didn’t answer'} — find another driver`;
  return '';
}

async function loadOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, user: true, deliveryOffers: { orderBy: { offeredAt: 'desc' }, take: 1, include: { driver: true } } },
  });
}

/** Sends a new card to the order-alerts chat and remembers it, so later changes can update it. */
async function sendAdminCard(o: FullOrder) {
  if (!bot) return;
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!settings?.adminChatId) return;
  const text = adminCardText(o);
  const reply_markup = adminKeyboard(o);
  const msg = o.paymentProofKey
    ? await bot.api.sendPhoto(settings.adminChatId, telegramPhoto(o.paymentProofKey, 'lg'), {
        caption: text.slice(0, 1024),
        parse_mode: 'HTML',
        reply_markup,
      })
    : await bot.api.sendMessage(settings.adminChatId, text, {
        parse_mode: 'HTML',
        reply_markup,
        link_preview_options: { is_disabled: true },
      });
  await prisma.adminCard.create({
    data: { orderId: o.id, chatId: settings.adminChatId, messageId: msg.message_id, hasPhoto: Boolean(o.paymentProofKey) },
  });
}

/**
 * Re-renders EVERY card of this order with its current state — whoever changed it (dashboard, bot,
 * automation). Stale buttons disappear, so the cards always match the dashboard.
 */
export async function refreshAdminCards(orderId: string, footer?: string) {
  if (!bot) return;
  const [o, cards] = await Promise.all([loadOrder(orderId), prisma.adminCard.findMany({ where: { orderId } })]);
  if (!o || !cards.length) return;
  const text = adminCardText(o, footer);
  const reply_markup = adminKeyboard(o);
  for (const card of cards) {
    try {
      if (card.hasPhoto) {
        await bot.api.editMessageCaption(card.chatId, card.messageId, { caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup });
      } else {
        await bot.api.editMessageText(card.chatId, card.messageId, text, {
          parse_mode: 'HTML',
          reply_markup,
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/message is not modified/i.test(message)) continue;
      if (/message to edit not found|chat not found|bot was kicked|MESSAGE_ID_INVALID/i.test(message)) {
        await prisma.adminCard.delete({ where: { id: card.id } }).catch(() => undefined); // card was deleted by staff
        continue;
      }
      logger.warn({ err: message, orderId }, 'could not refresh order card');
    }
  }
}

// ─── Customer messages ───────────────────────────────────

function customerMessage(o: FullOrder, kind: OrderEventKind): string | null {
  const am = o.user?.languageCode === 'am';
  const n = `<b>${escapeHtml(o.orderNumber)}</b>`;
  switch (kind) {
    case 'placed':
      return am
        ? `🧾 ትዕዛዝዎ ${n} ደርሶናል።\nጠቅላላ: ${birr(o.total)}`
        : `🧾 We received your order ${n}.\nTotal: ${birr(o.total)}`;
    case 'payment_verified':
      return am ? `✅ የ${n} ክፍያዎ ተረጋግጧል። እናመሰግናለን!` : `✅ Payment for ${n} confirmed. Thank you!`;
    case 'payment_rejected':
      return am
        ? `⚠️ የ${n} ክፍያዎን ማረጋገጥ አልቻልንም። እባክዎ ደረሰኙን እንደገና ይላኩ።`
        : `⚠️ We couldn't confirm the payment for ${n}. Please send the receipt again.`;
    case 'status': {
      const map: Partial<Record<OrderStatus, [string, string]>> = {
        CONFIRMED: [`✅ Order ${n} is confirmed.`, `✅ ትዕዛዝ ${n} ተረጋግጧል።`],
        PACKING: [`📦 We're preparing ${n}.`, `📦 ${n} እየተዘጋጀ ነው።`],
        OUT_FOR_DELIVERY: [`🚚 ${n} is on the way.`, `🚚 ${n} በመንገድ ላይ ነው።`],
        DELIVERED: [`🏁 ${n} delivered. Enjoy!`, `🏁 ${n} ደርሷል። እናመሰግናለን!`],
        PICKED_UP: [`🏁 Thanks for picking up ${n}.`, `🏁 ${n} ስለወሰዱ እናመሰግናለን።`],
        CANCELLED: [`✖️ Order ${n} was cancelled.`, `✖️ ትዕዛዝ ${n} ተሰርዟል።`],
      };
      const pair = map[o.status];
      if (!pair) return null;
      // On the way: the delivery code the customer gives the driver (only the customer gets it)
      if (o.status === 'OUT_FOR_DELIVERY' && o.deliveryCode) {
        return am
          ? `${pair[1]}

🔐 የማድረሻ ኮድ: <b>${o.deliveryCode}</b>
ዕቃውን ሲቀበሉ ብቻ ለአድራሹ ይንገሩት።`
          : `${pair[0]}

🔐 Delivery code: <b>${o.deliveryCode}</b>
Give it to the delivery person only when you have the items.`;
      }
      return am ? pair[1] : pair[0];
    }
    default:
      return null;
  }
}

async function sendCustomerMessage(o: FullOrder, kind: OrderEventKind) {
  if (!bot || !o.telegramChatId) return;
  const text = customerMessage(o, kind);
  if (!text) return;
  const am = o.user?.languageCode === 'am';
  const kb = new InlineKeyboard();
  // Backup confirmation: the customer can confirm receipt themselves
  if (kind === 'status' && o.status === 'OUT_FOR_DELIVERY' && o.deliveryCode) kb.text(am ? '✅ ተቀብያለሁ' : '✅ I received it', `rc:${o.id}:ask`).row();
  kb.webApp(am ? 'ትዕዛዙን ይመልከቱ' : 'View order', shopUrl(`/orders/${o.orderNumber}`));
  await bot.api.sendMessage(o.telegramChatId.toString(), text, { parse_mode: 'HTML', reply_markup: kb });
}

/**
 * Fire-and-forget: never blocks or fails the request that triggered it.
 * Customers only receive messages if they have started the bot.
 */
/** Tells the order-alerts chat that a channel post became a draft, with a button to review it. */
export async function notifyNewDraft(draft: { productId: string; name: string; price: number | null; photos: number }) {
  if (!bot) return;
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!settings?.adminChatId) return;
  const price = draft.price ? birr(draft.price) : 'no price yet';
  await bot.api.sendMessage(
    settings.adminChatId,
    [
      '📥 <b>New draft from your channel</b>',
      `${escapeHtml(draft.name)} · ${price} · ${draft.photos} photo${draft.photos === 1 ? '' : 's'}`,
      '',
      'Check the name, sizes and stock, then put it on sale.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('✏️  Review draft', shopUrl(`/admin/products/${draft.productId}`)) },
  );
}

export function notifyOrderEvent(orderId: string, kind: OrderEventKind) {
  if (!bot) return;
  void (async () => {
    const o = await loadOrder(orderId);
    if (!o) return;
    const tasks: Promise<unknown>[] = [sendCustomerMessage(o, kind)];
    // Every change updates the cards already in the chat; a new order or new payment proof also gets a fresh card
    if (kind !== 'placed') tasks.push(refreshAdminCards(o.id));
    if (kind === 'placed' || kind === 'payment_submitted') tasks.push(sendAdminCard(o));
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') logger.warn({ err: r.reason, orderId, kind }, 'telegram notify failed');
  })().catch((err) => logger.warn({ err, orderId }, 'telegram notify failed'));
}

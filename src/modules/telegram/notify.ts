import { InlineKeyboard, type Context } from 'grammy';
import type { Order, OrderItem, OrderStatus, User } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { bot, shopUrl } from './bot';
import { birr, escapeHtml, telegramPhoto } from './media';

export type OrderEventKind = 'placed' | 'payment_submitted' | 'payment_verified' | 'payment_rejected' | 'status';

type FullOrder = Order & { items: OrderItem[]; user: User | null };

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
    `<b>Total:</b> ${birr(o.total)}${o.deliveryFee === null ? ' + delivery (by phone)' : ''}`,
    `<b>Due now:</b> ${birr(o.amountDue)}${o.isDeposit ? ' (deposit)' : ''}`,
    `<b>Payment:</b> ${escapeHtml(o.paymentLabel ?? '-')} — ${PAYMENT_LABEL[o.paymentStatus]}`,
    o.transactionRef ? `<b>Ref:</b> <code>${escapeHtml(o.transactionRef)}</code>` : '',
    '',
    `👤 ${escapeHtml(o.customerName)} · <a href="tel:${o.customerPhone}">${o.customerPhone}</a>${
      o.user?.telegramUsername ? ` · @${escapeHtml(o.user.telegramUsername)}` : ''
    }`,
    `📍 ${escapeHtml(o.deliveryLabel)}${[o.city, o.area, o.landmark].filter(Boolean).length ? ` — ${escapeHtml([o.city, o.area, o.landmark].filter(Boolean).join(', '))}` : ''}`,
    o.lat !== null && o.lng !== null ? `🗺 <a href="https://maps.google.com/?q=${o.lat},${o.lng}">Map pin</a>` : '',
    o.note ? `📝 ${escapeHtml(o.note)}` : '',
    footer ? `\n<i>${escapeHtml(footer)}</i>` : '',
  ];
  return lines.filter((l, idx, arr) => l !== '' || arr[idx - 1] !== '').join('\n').trim();
}

function adminKeyboard(o: FullOrder) {
  const kb = new InlineKeyboard();
  const id = o.id;
  if (o.status === 'CANCELLED' || o.status === 'DELIVERED' || o.status === 'PICKED_UP') return kb;
  if (o.paymentStatus === 'SUBMITTED' || o.paymentStatus === 'UNPAID' || o.paymentStatus === 'REJECTED') {
    kb.text('✅ Payment OK', `o:${id}:verify`);
    if (o.paymentStatus === 'SUBMITTED') kb.text('⚠️ Reject', `o:${id}:reject`);
    kb.row();
  }
  const pickup = o.deliveryOptionId === 'pickup';
  if (o.status === 'PENDING' || o.status === 'CONFIRMED') kb.text('📦 Packing', `o:${id}:PACKING`);
  if (o.status !== 'OUT_FOR_DELIVERY' && !pickup) kb.text('🚚 On the way', `o:${id}:OUT_FOR_DELIVERY`);
  kb.row();
  kb.text(pickup ? '🏁 Picked up' : '🏁 Delivered', `o:${id}:${pickup ? 'PICKED_UP' : 'DELIVERED'}`);
  kb.text('✖️ Cancel', `o:${id}:CANCELLED`);
  return kb;
}

async function loadOrder(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, include: { items: true, user: true } });
}

async function sendAdminCard(o: FullOrder) {
  if (!bot) return;
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  if (!settings?.adminChatId) return;
  const text = adminCardText(o);
  const reply_markup = adminKeyboard(o);
  if (o.paymentProofKey) {
    await bot.api.sendPhoto(settings.adminChatId, telegramPhoto(o.paymentProofKey, 'lg'), {
      caption: text.slice(0, 1024),
      parse_mode: 'HTML',
      reply_markup,
    });
  } else {
    await bot.api.sendMessage(settings.adminChatId, text, {
      parse_mode: 'HTML',
      reply_markup,
      link_preview_options: { is_disabled: true },
    });
  }
}

/** Re-renders the card after an admin pressed a button on it. */
export async function refreshAdminCard(orderId: string, ctx: Context, actorName: string) {
  const o = await loadOrder(orderId);
  if (!o) return;
  const text = adminCardText(o, `Last action by ${actorName}`);
  const reply_markup = adminKeyboard(o);
  const msg = ctx.callbackQuery?.message;
  if (msg && 'photo' in msg && msg.photo) {
    await ctx.editMessageCaption({ caption: text.slice(0, 1024), parse_mode: 'HTML', reply_markup }).catch(() => undefined);
  } else {
    await ctx
      .editMessageText(text, { parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } })
      .catch(() => undefined);
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
      return pair ? (am ? pair[1] : pair[0]) : null;
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
  await bot.api.sendMessage(o.telegramChatId.toString(), text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().webApp(am ? 'ትዕዛዙን ይመልከቱ' : 'View order', shopUrl(`/orders/${o.orderNumber}`)),
  });
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
    if (kind === 'placed' || kind === 'payment_submitted') tasks.push(sendAdminCard(o));
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') logger.warn({ err: r.reason, orderId, kind }, 'telegram notify failed');
  })().catch((err) => logger.warn({ err, orderId }, 'telegram notify failed'));
}

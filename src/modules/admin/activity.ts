/**
 * Staff activity log — "who did what". Every successful change made through the admin API is
 * recorded automatically by one middleware (so new admin features are covered without extra code),
 * with a plain-language summary like "HM-2611-ABCD → Delivered" or "Edited Navy Slim Suit".
 * Telegram button presses by staff are logged by the bot with the same helper.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/http';
import { requireOwner } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { STATUS_LABEL } from '../orders/rules';

export async function logActivity(entry: { actorId?: string | null; actorName: string; action: string; summary: string; entity?: string; entityId?: string }) {
  try {
    await prisma.activityLog.create({ data: { actorId: entry.actorId ?? null, actorName: entry.actorName, action: entry.action, summary: entry.summary, entity: entry.entity, entityId: entry.entityId } });
  } catch (err) {
    logger.warn({ err }, 'activity log write failed');
  }
}

const orderNo = async (id: string) => (await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } }))?.orderNumber ?? 'an order';
const productName = async (id: string) => (await prisma.product.findUnique({ where: { id }, select: { nameEn: true } }))?.nameEn ?? 'a product';
const money = (n: unknown) => (typeof n === 'number' ? `${n.toLocaleString('en-US')} ETB` : '');

type Described = { action: string; summary: string; entity?: string; entityId?: string } | null;

/** Turns an admin request into a sentence. Unknown routes still get a generic line. */
async function describe(method: string, path: string, body: Record<string, unknown>): Promise<Described> {
  const p = path.replace(/\?.*$/, '').replace(/\/+$/, '');
  let m: RegExpMatchArray | null;

  if ((m = p.match(/^\/orders\/([^/]+)\/refunded$/)))
    return { action: 'order.refunded', summary: `Refunded ${await orderNo(m[1]!)} — ${String(body.note ?? '').slice(0, 120)}`, entity: 'order', entityId: m[1] };
  if ((m = p.match(/^\/orders\/([^/]+)\/cancel\/(undo|now)$/)))
    return {
      action: m[2] === 'undo' ? 'order.cancel_undone' : 'order.cancel_now',
      summary: m[2] === 'undo' ? `Undid the cancel of ${await orderNo(m[1]!)}` : `Cancelled ${await orderNo(m[1]!)} right away`,
      entity: 'order',
      entityId: m[1],
    };
  if ((m = p.match(/^\/orders\/([^/]+)\/status$/)) && body.status === 'CANCELLED')
    return { action: 'order.cancel_requested', summary: `Asked to cancel ${await orderNo(m[1]!)} (undo possible for a few minutes)`, entity: 'order', entityId: m[1] };
  if ((m = p.match(/^\/orders\/([^/]+)\/status$/))) {
    const how =
      body.status === 'DELIVERED'
        ? body.overrideReason
          ? ` ⚠️ WITHOUT the customer’s code — “${String(body.overrideReason).trim().slice(0, 120)}”`
          : body.code
            ? ' (customer’s code confirmed)'
            : ''
        : '';
    return { action: body.overrideReason ? 'order.delivered_override' : 'order.status', summary: `${await orderNo(m[1]!)} → ${STATUS_LABEL[body.status as keyof typeof STATUS_LABEL] ?? body.status}${how}`, entity: 'order', entityId: m[1] };
  }
  if ((m = p.match(/^\/orders\/([^/]+)\/payment$/)))
    return {
      action: 'order.payment',
      summary: body.approve ? `Confirmed payment on ${await orderNo(m[1]!)}${body.amountPaid ? ` (${money(body.amountPaid)})` : ''}` : `Rejected payment on ${await orderNo(m[1]!)}`,
      entity: 'order',
      entityId: m[1],
    };
  if ((m = p.match(/^\/orders\/([^/]+)\/note$/))) return { action: 'order.note', summary: `Note on ${await orderNo(m[1]!)}`, entity: 'order', entityId: m[1] };
  if ((m = p.match(/^\/orders\/([^/]+)\/dispatch\/cancel$/))) return { action: 'order.dispatch_cancel', summary: `Cancelled the driver for ${await orderNo(m[1]!)}`, entity: 'order', entityId: m[1] };
  if (p.match(/^\/orders\/([^/]+)\/dispatch$/)) return null; // logged by dispatch() itself, with the driver's name
  if ((m = p.match(/^\/orders\/([^/]+)\/handover$/))) return { action: 'order.handover', summary: `Handed ${await orderNo(m[1]!)} to the driver — on the way`, entity: 'order', entityId: m[1] };
  if (p === '/orders' && method === 'POST') return { action: 'order.create', summary: `Created an order for ${String(body.customerName ?? 'a customer')}`, entity: 'order' };

  if (p === '/products' && method === 'POST') return { action: 'product.create', summary: `Created ${String(body.nameEn ?? 'a product')}`, entity: 'product' };
  if ((m = p.match(/^\/products\/([^/]+)$/))) {
    if (method === 'DELETE') return { action: 'product.delete', summary: 'Deleted (or archived) a product', entity: 'product', entityId: m[1] };
    return { action: 'product.edit', summary: `Edited ${String(body.nameEn ?? (await productName(m[1]!)))}${body.basePrice ? ` · ${money(body.basePrice)}` : ''}`, entity: 'product', entityId: m[1] };
  }
  if ((m = p.match(/^\/products\/([^/]+)\/status$/))) return { action: 'product.status', summary: `${await productName(m[1]!)} → ${body.status === 'ACTIVE' ? 'on sale' : String(body.status).toLowerCase()}`, entity: 'product', entityId: m[1] };
  if ((m = p.match(/^\/products\/([^/]+)\/variants$/))) {
    const total = Array.isArray(body.variants) ? (body.variants as { stock?: number }[]).reduce((n, v) => n + (v.stock ?? 0), 0) : null;
    return { action: 'product.stock', summary: `Stock of ${await productName(m[1]!)}${total !== null ? ` set to ${total} pcs` : ''}`, entity: 'product', entityId: m[1] };
  }
  if ((m = p.match(/^\/products\/([^/]+)\/(images|proofs)/))) return { action: `product.${m[2]}`, summary: `${method === 'DELETE' ? 'Removed' : 'Changed'} ${m[2] === 'proofs' ? 'proof photos' : 'photos'} of ${await productName(m[1]!)}`, entity: 'product', entityId: m[1] };
  if ((m = p.match(/^\/products\/([^/]+)\/publish$/))) return { action: 'product.publish', summary: `Posted ${await productName(m[1]!)} to the channel`, entity: 'product', entityId: m[1] };
  if ((m = p.match(/^\/products\/([^/]+)\/announce$/))) return { action: 'product.announce', summary: `Announced ${await productName(m[1]!)} to subscribers`, entity: 'product', entityId: m[1] };

  if (p === '/counter' && method === 'POST') {
    const n = Array.isArray(body.items) ? (body.items as { quantity?: number }[]).reduce((s, i) => s + (i.quantity ?? 1), 0) : 0;
    return { action: 'counter.sale', summary: `Shop sale · ${n} pc${n === 1 ? '' : 's'}`, entity: 'counter' };
  }
  if ((m = p.match(/^\/counter\/([^/]+)\/undo$/))) return { action: 'counter.undo', summary: `Undid shop sale ${await orderNo(m[1]!)}`, entity: 'order', entityId: m[1] };

  if ((m = p.match(/^\/promotions(?:\/([^/]+))?$/))) return { action: 'promotion', summary: `${method === 'DELETE' ? 'Removed' : method === 'POST' ? 'Created' : 'Edited'} offer ${String(body.name ?? '')}`.trim(), entity: 'promotion', entityId: m[1] };
  if ((m = p.match(/^\/bundles(?:\/([^/]+))?$/))) return { action: 'bundle', summary: `${method === 'DELETE' ? 'Removed' : method === 'POST' ? 'Created' : 'Edited'} look ${String(body.name ?? '')}`.trim(), entity: 'bundle', entityId: m[1] };
  if (p.startsWith('/settings')) {
    const keys = Object.keys(body).filter((k) => k !== 'apiKey');
    return { action: 'settings', summary: `Changed settings${keys.length ? `: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? '…' : ''}` : ''}`, entity: 'settings' };
  }
  if (p.startsWith('/staff')) return { action: 'staff', summary: method === 'POST' ? `Added admin ${String(body.fullName ?? '')}`.trim() : method === 'DELETE' ? 'Removed an admin' : 'Changed an admin', entity: 'staff' };
  if ((m = p.match(/^\/support\/([^/]+)\/reply$/))) return { action: 'support.reply', summary: `Answered a customer question${body.solve ? ' (solved)' : ''}`, entity: 'support', entityId: m[1] };
  if ((m = p.match(/^\/support\/([^/]+)$/))) return { action: 'support.status', summary: `Question marked ${String(body.status)}`, entity: 'support', entityId: m[1] };
  if ((m = p.match(/^\/exchanges\/([^/]+)$/))) return { action: 'exchange', summary: `Exchange ${String(body.status)}`, entity: 'exchange', entityId: m[1] };
  if ((m = p.match(/^\/reviews\/([^/]+)$/))) return { action: 'review', summary: `${body.status === 'hidden' ? 'Hid' : 'Showed'} a review`, entity: 'review', entityId: m[1] };
  if ((m = p.match(/^\/drivers(?:\/([^/]+))?/))) return { action: 'driver', summary: method === 'POST' && !m[1] ? `Added driver ${String(body.name ?? '')}`.trim() : 'Changed a driver', entity: 'driver', entityId: m[1] };
  if (p.startsWith('/categories') || p.startsWith('/brands')) return { action: 'catalog', summary: 'Changed categories / brands', entity: 'catalog' };
  // Never the card contents — only that a check happened, and for whom
  if (p === '/identity' && method === 'POST')
    return { action: 'identity.verify', summary: `Checked the Fayda ID of a ${body.type === 'driver' ? 'delivery person' : 'admin'}`, entity: String(body.type ?? ''), entityId: String(body.id ?? '') };
  return { action: 'other', summary: `${method} ${p}` };
}

/** Mounted on /api/admin: records every successful change (not reads). */
export function recordActivity(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const path = req.path;
  const body = (req.body && typeof req.body === 'object' ? { ...req.body } : {}) as Record<string, unknown>;
  res.on('finish', () => {
    const user = req.user;
    if (!user || res.statusCode >= 400) return;
    void describe(req.method, path, body)
      .then((d) => d && logActivity({ actorId: user.id, actorName: user.fullName, ...d }))
      .catch((err) => logger.warn({ err }, 'activity describe failed'));
  });
  next();
}

export const activityRouter = Router();
activityRouter.use(requireOwner);

activityRouter.get(
  '/',
  validate(z.object({ actor: z.string().max(40).optional(), entity: z.string().max(20).optional(), before: z.coerce.date().optional() }), 'query'),
  ah(async (req, res) => {
    const { actor, entity, before } = req.query as unknown as { actor?: string; entity?: string; before?: Date };
    const logs = await prisma.activityLog.findMany({
      where: { ...(actor ? { actorId: actor } : {}), ...(entity ? { entity } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    const people = await prisma.activityLog.groupBy({ by: ['actorId', 'actorName'], _count: true, orderBy: { _count: { actorId: 'desc' } }, take: 20 });
    res.json({ logs, people: people.map((p) => ({ id: p.actorId, name: p.actorName, count: p._count })), hasMore: logs.length === 60 });
  }),
);

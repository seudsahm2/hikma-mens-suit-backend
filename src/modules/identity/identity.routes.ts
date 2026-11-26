/**
 * Owner only: verify the Fayda ID of a delivery person or an admin.
 * The owner scans the card (camera or photo) in the admin; the QR TEXT is sent here and verified on
 * the server (NIDP signature) — the browser's result is never trusted. Only genuine cards are saved.
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { ah, badRequest, notFound } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { requireOwner, requireStaff } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { parseFayda, verifyFayda } from './fayda';

export const identityRouter = Router();
const owner = [requireStaff, requireOwner];
const subject = z.object({ type: z.enum(['driver', 'staff']), id: z.string().min(1).max(40) });

async function subjectName(type: 'driver' | 'staff', id: string) {
  if (type === 'driver') return (await prisma.driver.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
  return (await prisma.user.findFirst({ where: { id, role: { in: ['ADMIN', 'OWNER'] } }, select: { fullName: true } }))?.fullName ?? null;
}

const view = (c: { id: string; fullName: string; gender: string | null; dateOfBirth: string | null; fan: string; cardVersion: string; createdAt: Date; face: Uint8Array | null }) => ({
  id: c.id,
  fullName: c.fullName,
  gender: c.gender,
  dateOfBirth: c.dateOfBirth,
  fan: c.fan,
  cardVersion: c.cardVersion,
  hasPhoto: Boolean(c.face?.length),
  verifiedAt: c.createdAt,
});

/** Who has a verified Fayda ID (badges in the driver / admin lists). */
identityRouter.get(
  '/identity-summary',
  ...owner,
  ah(async (_req, res) => {
    const rows = await prisma.identityCheck.findMany({ distinct: ['subjectType', 'subjectId'], select: { subjectType: true, subjectId: true } });
    res.set('Cache-Control', 'no-store');
    res.json({ driver: rows.filter((r) => r.subjectType === 'driver').map((r) => r.subjectId), staff: rows.filter((r) => r.subjectType === 'staff').map((r) => r.subjectId) });
  }),
);

// (declared before /identity/:type/:id, which would otherwise catch "photo" as a type)
/** The face photo from the card — only to the owner, never cached by the browser or a proxy. */
identityRouter.get(
  '/identity/photo/:checkId',
  ...owner,
  ah(async (req, res) => {
    const c = await prisma.identityCheck.findUnique({ where: { id: req.params.checkId }, select: { face: true } });
    if (!c?.face?.length) throw notFound('No photo');
    res.set('Cache-Control', 'no-store, private');
    res.type('image/webp').send(Buffer.from(c.face));
  }),
);

identityRouter.get(
  '/identity/:type/:id',
  ...owner,
  ah(async (req, res) => {
    const { type, id } = subject.parse({ type: req.params.type, id: req.params.id });
    const c = await prisma.identityCheck.findFirst({ where: { subjectType: type, subjectId: id }, orderBy: { createdAt: 'desc' } });
    res.set('Cache-Control', 'no-store');
    res.json({ check: c ? view(c) : null });
  }),
);

identityRouter.post(
  '/identity',
  ...owner,
  validate(z.object({ type: z.enum(['driver', 'staff']), id: z.string().min(1).max(40), qr: z.string().min(20).max(20_000) })),
  ah(async (req, res) => {
    const { type, id, qr } = req.body as { type: 'driver' | 'staff'; id: string; qr: string };
    const name = await subjectName(type, id);
    if (!name) throw notFound(type === 'driver' ? 'Delivery person not found' : 'Admin not found');
    const parsed = parseFayda(qr);
    if (!parsed.ok) throw badRequest(parsed.reason === 'UNSUPPORTED_VERSION' ? `This card version (${parsed.version || '?'}) isn’t supported yet` : 'That QR code isn’t a Fayda ID card', parsed.reason);
    let v = verifyFayda(parsed.card);
    // Local testing with synthetic cards — never in production
    // (the PEM is stored on one line in the env file with literal "\n" between lines)
    if (!v.verified && !env.isProd && env.FAYDA_TEST_PUBLIC_KEY) v = verifyFayda(parsed.card, env.FAYDA_TEST_PUBLIC_KEY.split('\\n').join('\n'));
    if (!v.verified) throw badRequest('This card’s NIDP signature does not verify — it is not a genuine Fayda card (or the QR was edited).', v.reason);
    if (!parsed.card.fan) throw badRequest('The card has no readable Fayda number', 'NO_FAN');

    // Same card already used for someone else? Show it — the owner decides.
    const other = await prisma.identityCheck.findFirst({ where: { fan: parsed.card.fan, NOT: { subjectType: type, subjectId: id } }, orderBy: { createdAt: 'desc' } });
    const c = await prisma.identityCheck.create({
      data: {
        subjectType: type,
        subjectId: id,
        fullName: parsed.card.fullName,
        gender: parsed.card.gender,
        dateOfBirth: parsed.card.dateOfBirth,
        fan: parsed.card.fan,
        cardVersion: parsed.card.version,
        keyFingerprint: v.fingerprint,
        face: parsed.card.face ? new Uint8Array(parsed.card.face) : null,
        checkedById: req.user!.id,
      },
    });
    res.status(201).json({
      check: view(c),
      registeredAs: name,
      alsoUsedFor: other ? { type: other.subjectType, id: other.subjectId, name: await subjectName(other.subjectType as 'driver' | 'staff', other.subjectId) } : null,
    });
  }),
);


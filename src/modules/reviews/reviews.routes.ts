import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/http';
import { deleteImage, saveImage } from '../../lib/storage';
import { requireAuth, requireStaff } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { imageUpload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { assertCanReview, recomputeRating, serializeReview, toReview } from './reviews.service';

const withUser = { photos: true, user: { select: { fullName: true } } } as const;

// ─── Public + customer ───────────────────────────────────

export const reviewsRouter = Router();

/** Published reviews of a product, with the rating summary. */
reviewsRouter.get(
  '/',
  validate(z.object({ product: z.string().min(1).max(120), page: z.coerce.number().int().min(1).max(50).default(1) }), 'query'),
  ah(async (req, res) => {
    const { product: slug, page } = req.query as unknown as { product: string; page: number };
    const product = await prisma.product.findFirst({ where: { slug, status: 'ACTIVE' }, select: { id: true } });
    if (!product) throw notFound('Product not found');
    const where = { productId: product.id, status: 'published' };
    const limit = 10;
    const [reviews, total, dist] = await Promise.all([
      prisma.review.findMany({ where, include: withUser, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ['rating'], where, _count: true }),
    ]);
    const sum = dist.reduce((n, d) => n + d.rating * d._count, 0);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      summary: {
        average: total ? Math.round((sum / total) * 10) / 10 : null,
        count: total,
        distribution: [5, 4, 3, 2, 1].map((r) => dist.find((d) => d.rating === r)?._count ?? 0),
        withPhotos: await prisma.review.count({ where: { ...where, photos: { some: {} } } }),
      },
      reviews: reviews.map(serializeReview),
      hasMore: page * limit < total,
    });
  }),
);

/** What the signed-in customer can review (received, not yet reviewed). */
reviewsRouter.get(
  '/to-write',
  requireAuth,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ items: await toReview(req.user!.id) });
  }),
);

const reviewBody = z.object({
  productId: z.string().min(1).max(40),
  rating: z.coerce.number().int().min(1).max(5),
  text: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || null),
});

/** Write (or rewrite) a review, with up to 4 photos. */
reviewsRouter.post(
  '/',
  requireAuth,
  limiter({ windowMs: 60 * 60_000, limit: 30 }),
  imageUpload.array('photos', 4),
  ah(async (req, res) => {
    const parsed = reviewBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Choose a rating from 1 to 5 stars', 'VALIDATION');
    const { productId, rating, text } = parsed.data;
    const userId = req.user!.id;
    const item = await assertCanReview(userId, productId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    const existing = await prisma.review.findUnique({ where: { userId_productId: { userId, productId } }, include: { photos: true } });
    const review = existing
      ? await prisma.review.update({ where: { id: existing.id }, data: { rating, text, size: item.size } })
      : await prisma.review.create({ data: { productId, userId, orderId: item.orderId, rating, text, size: item.size } });

    if (files.length) {
      // New photos replace the old ones
      if (existing?.photos.length) {
        await prisma.reviewPhoto.deleteMany({ where: { reviewId: review.id } });
        await Promise.all(existing.photos.map((p) => deleteImage(p.key)));
      }
      let i = 0;
      for (const file of files) {
        const saved = await saveImage(file.buffer, 'reviews');
        await prisma.reviewPhoto.create({ data: { reviewId: review.id, key: saved.key, width: saved.width, height: saved.height, sortOrder: i++ } });
      }
    }
    await recomputeRating(productId);
    const full = await prisma.review.findUniqueOrThrow({ where: { id: review.id }, include: withUser });
    res.status(existing ? 200 : 201).json({ review: serializeReview(full) });
  }),
);

// ─── Staff moderation ────────────────────────────────────

export const adminReviewsRouter = Router();
adminReviewsRouter.use(requireStaff);

adminReviewsRouter.get(
  '/',
  validate(z.object({ status: z.enum(['published', 'hidden']).optional(), page: z.coerce.number().int().min(1).default(1) }), 'query'),
  ah(async (req, res) => {
    const { status, page } = req.query as unknown as { status?: string; page: number };
    const where = status ? { status } : {};
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { ...withUser, product: { select: { id: true, nameEn: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 30,
        take: 30,
      }),
      prisma.review.count({ where }),
    ]);
    res.json({
      reviews: reviews.map((r) => ({ ...serializeReview(r), status: r.status, product: r.product, customer: r.user.fullName })),
      total,
      hasMore: page * 30 < total,
    });
  }),
);

adminReviewsRouter.patch(
  '/:id',
  validate(z.object({ status: z.enum(['published', 'hidden']) })),
  ah(async (req, res) => {
    const r = await prisma.review.update({ where: { id: req.params.id }, data: { status: req.body.status } });
    await recomputeRating(r.productId);
    res.json({ ok: true });
  }),
);

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { installBigIntJson } from './lib/json';
import { LOCAL_UPLOAD_DIR, storageMode } from './lib/storage';
import { prisma } from './lib/prisma';
import { loadUser, requireStaff } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './modules/auth/auth.routes';
import { catalogRouter } from './modules/catalog/catalog.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { adminProductsRouter } from './modules/admin/products.routes';
import { adminOrdersRouter } from './modules/admin/orders.routes';
import { adminCounterRouter } from './modules/admin/counter.routes';
import { adminStoreRouter } from './modules/admin/store.routes';
import { telegramWebhook } from './modules/telegram/bot';
import { geoRouter } from './modules/geo/geo.routes';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { cartRouter } from './modules/cart/cart.routes';
import { adminReviewsRouter, reviewsRouter } from './modules/reviews/reviews.routes';
import { pricingRouter } from './modules/pricing/pricing.routes';
import { adminPromotionsRouter } from './modules/admin/promotions.routes';
import { wishlistRouter } from './modules/after/wishlist';
import { adminExchangesRouter, exchangesRouter } from './modules/after/exchanges';
import { adminSupportRouter, supportRouter } from './modules/after/support';
import { activityRouter, recordActivity } from './modules/admin/activity';
import { driversRouter } from './modules/delivery/drivers';
import './modules/delivery/driverProfile'; // registers the ⭐ rating buttons
import { insightsRouter } from './modules/admin/insights';

installBigIntJson();

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render / Vercel sit behind a proxy

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // images are loaded by the frontend origin
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / server-to-server (no Origin header) and configured frontends
        if (!origin || env.clientOrigins.includes(origin)) return cb(null, true);
        if (!env.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        cb(null, false);
      },
    }),
  );
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  // Telegram webhook must see the raw JSON before other middleware touches it
  const webhook = telegramWebhook();
  if (webhook && env.TELEGRAM_WEBHOOK_SECRET) {
    app.post(`/api/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`, express.json(), webhook);
  }

  app.use(express.json({ limit: '200kb' }));

  if (storageMode === 'local') {
    app.use('/uploads', express.static(LOCAL_UPLOAD_DIR, { maxAge: '30d', immutable: true }));
  }

  // Root: a short status so opening the API address in a browser isn't a confusing 404
  app.get('/', (_req, res) => {
    res.json({ service: 'Hikma Men’s Fashion API', status: 'running', health: '/api/health', shop: env.clientUrl });
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api', loadUser);
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/geo', geoRouter);
  app.use('/api', catalogRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/reviews', reviewsRouter);
  app.use('/api', pricingRouter);
  app.use('/api/wishlist', wishlistRouter);
  app.use('/api/exchanges', exchangesRouter);
  app.use('/api/admin', recordActivity); // who did what (every successful change below)
  app.use('/api/admin/activity', activityRouter);
  app.use('/api/admin/insights', requireStaff, insightsRouter);
  app.use('/api/admin', driversRouter);
  app.use('/api/admin/exchanges', adminExchangesRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/admin/support', adminSupportRouter);
  app.use('/api/admin/reviews', adminReviewsRouter);
  app.use('/api/admin/products', requireStaff, adminProductsRouter);
  app.use('/api/admin/orders', requireStaff, adminOrdersRouter);
  app.use('/api/admin/counter', requireStaff, adminCounterRouter);
  app.use('/api/admin', requireStaff, adminPromotionsRouter);
  app.use('/api/admin', requireStaff, adminStoreRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

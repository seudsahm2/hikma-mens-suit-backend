import { env } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { storageMode } from './lib/storage';
import { cancelStaleUnpaidOrders } from './modules/orders/orders.service';
import { bot, startPollingIfEnabled } from './modules/telegram/bot';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, storage: storageMode, telegram: bot ? (env.TELEGRAM_POLLING ? 'polling' : 'webhook') : 'off' },
    'Hikma API ready',
  );
});

void startPollingIfEnabled();

// Catch a token from another bot early: sign-in links and the Mini App would silently fail
if (bot) {
  bot.api.getMe().then(
    (me) => {
      if (me.username?.toLowerCase() !== env.TELEGRAM_BOT_USERNAME.toLowerCase()) {
        logger.error(
          { tokenBot: me.username, expected: env.TELEGRAM_BOT_USERNAME },
          'TELEGRAM_BOT_TOKEN belongs to a different bot than TELEGRAM_BOT_USERNAME — Telegram sign-in will not work',
        );
      }
    },
    (err) => logger.warn({ err: (err as Error).message }, 'could not reach Telegram to verify the bot token'),
  );
}

// Release stock held by orders that were never paid (checked every 30 minutes)
const sweeper = setInterval(() => {
  cancelStaleUnpaidOrders().then(
    (n) => n && logger.info({ cancelled: n }, 'released stale unpaid orders'),
    (err) => logger.warn({ err }, 'stale order sweep failed'),
  );
}, 30 * 60 * 1000);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  if (bot && env.TELEGRAM_POLLING) await bot.stop().catch(() => undefined);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

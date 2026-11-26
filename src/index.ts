import { env } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { storageMode } from './lib/storage';
import { cancelStaleUnpaidOrders } from './modules/orders/orders.service';
import { bot, startChannelImportWorker, startPollingIfEnabled } from './modules/telegram/bot';
import { notifyNewDraft } from './modules/telegram/notify';
import { startBroadcastWorker } from './modules/telegram/broadcast';
import { startDailyReportWorker } from './modules/reports/dailyReport';
import { startBagReminderWorker } from './modules/cart/bagReminder';
import { startReviewRequestWorker } from './modules/reviews/reviews.service';
import { startDispatchWorker } from './modules/delivery/dispatch';
import { startBackupWorker } from './modules/backup/backup.service';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, storage: storageMode, telegram: bot ? (env.TELEGRAM_POLLING ? 'polling' : 'webhook') : 'off' },
    'Hikma API ready',
  );
});

void startPollingIfEnabled();

// Channel auto-import: new channel posts → draft products (+ a message to the order-alerts chat)
const stopChannelImport = startChannelImportWorker(notifyNewDraft);
// New-arrival announcements are sent in batches in the background
const stopBroadcasts = startBroadcastWorker();
// Evening summary to the order-alerts chat, and one reminder for bags left behind
const stopDailyReport = startDailyReportWorker();
const stopBagReminders = startBagReminderWorker();
// A day after delivery: "How do you like it? ⭐ Rate it"
const stopReviewRequests = startReviewRequestWorker();
// Driver job offers that weren't answered in time go to the next driver
const stopDispatch = startDispatchWorker();
// Daily encrypted database backup + new files → owner's Telegram
const stopBackups = startBackupWorker();

// Catch a token from another bot early: sign-in links and the Mini App would silently fail
if (bot) {
  bot.api.getMe().then(
    (me) => {
      if (me.username?.toLowerCase() !== env.TELEGRAM_BOT_USERNAME.toLowerCase()) {
        logger.error(
          { tokenBot: me.username, expected: env.TELEGRAM_BOT_USERNAME },
          'TELEGRAM_BOT_TOKEN belongs to a different bot than TELEGRAM_BOT_USERNAME — Telegram sign-in will not work',
        );
        return;
      }
      // Drivers' live location arrives as edited messages: make sure the webhook receives them
      // (keeps the existing webhook address and secret — no need to re-run bot:setup)
      if (!env.TELEGRAM_POLLING && env.TELEGRAM_WEBHOOK_SECRET) {
        void bot!.api.getWebhookInfo().then(async (info) => {
          if (!info.url || info.allowed_updates?.includes('edited_message')) return;
          await bot!.api.setWebhook(info.url, {
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
          });
          logger.info('webhook now also receives edited messages (driver live location)');
        }).catch((err) => logger.warn({ err: (err as Error).message }, 'could not update webhook updates'));
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
  stopChannelImport();
  stopBroadcasts();
  stopDailyReport();
  stopBagReminders();
  stopReviewRequests();
  stopDispatch();
  stopBackups();
  if (bot && env.TELEGRAM_POLLING) await bot.stop().catch(() => undefined);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * Configures the Telegram bot for production:
 *   - webhook → <API_URL>/api/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>
 *   - menu button → opens the Mini App (CLIENT_URL)
 *   - command list, name and descriptions (English + Amharic)
 *
 *   npm run bot:setup
 *
 * The Mini App itself (short name used in t.me/<bot>/<short_name> links) is created once
 * in @BotFather with /newapp — see README.
 */
import { env } from '../config/env';
import { Bot } from 'grammy';

async function main() {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error('TELEGRAM_WEBHOOK_SECRET is missing');
  if (!env.API_URL.startsWith('https://')) throw new Error('API_URL must be https:// for the Telegram webhook');
  if (!env.clientUrl.startsWith('https://')) throw new Error('CLIENT_URL must be https:// for the Mini App');

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const me = await bot.api.getMe();

  const url = `${env.apiUrl}/api/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
  await bot.api.setWebhook(url, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'channel_post'],
    drop_pending_updates: true,
  });

  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Shop', web_app: { url: env.clientUrl } } });

  await bot.api.setMyCommands([
    { command: 'start', description: 'Open the shop' },
    { command: 'orders', description: 'My orders' },
    { command: 'help', description: 'Contact & address' },
  ]);
  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'ሱቁን ይክፈቱ' },
      { command: 'orders', description: 'የኔ ትዕዛዞች' },
      { command: 'help', description: 'ስልክ እና አድራሻ' },
    ],
    { language_code: 'am' },
  );

  await bot.api.setMyShortDescription('Men’s fashion & perfumes · Betel, Addis Ababa');
  await bot.api.setMyDescription(
    'Suits, shirts, jeans, shoes and original perfumes. Order in a few taps — free delivery in Addis Ababa.',
  );
  await bot.api.setMyDescription('ሱፍ፣ ሸሚዝ፣ ጂንስ፣ ጫማ እና ኦሪጂናል ሽቶ። በጥቂት ንክኪ ይዘዙ — አዲስ አበባ ውስጥ ነፃ ማድረስ።', {
    language_code: 'am',
  });

  const info = await bot.api.getWebhookInfo();
  console.log(`✓ @${me.username} configured`);
  console.log(`  webhook: ${info.url}`);
  console.log(`  menu button → ${env.clientUrl}`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

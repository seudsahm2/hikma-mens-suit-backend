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

  // Telegram rate limits (429 "retry after N") are common when setup is run several times in a row:
  // wait the time Telegram asks for and try again, instead of failing.
  bot.api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 1; ; attempt++) {
      const res = await prev(method, payload, signal);
      const wait = !res.ok && res.error_code === 429 ? (res.parameters?.retry_after ?? 5) : 0;
      if (!wait || attempt >= 4) return res;
      console.log(`  … Telegram asks to wait ${wait}s (${method}), waiting…`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    }
  });

  const me = await bot.api.getMe();

  // Safety: never reconfigure a different bot because of a pasted token from another project
  if (me.username?.toLowerCase() !== env.TELEGRAM_BOT_USERNAME.toLowerCase()) {
    throw new Error(
      `TELEGRAM_BOT_TOKEN belongs to @${me.username}, but TELEGRAM_BOT_USERNAME is @${env.TELEGRAM_BOT_USERNAME}. ` +
        'Nothing was changed. Put the token of the right bot (BotFather → /mybots → the bot → API Token).',
    );
  }

  const url = `${env.apiUrl}/api/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
  await bot.api.setWebhook(url, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'], // edited_message: drivers' live location
    drop_pending_updates: true,
  });

  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Shop', web_app: { url: env.clientUrl } } });

  await bot.api.setMyCommands([
    { command: 'start', description: 'Open the shop' },
    { command: 'orders', description: 'My orders' },
    { command: 'help', description: 'Contact & address' },
    { command: 'news', description: 'New arrivals on' },
    { command: 'stop', description: 'New arrivals off' },
  ]);
  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'ሱቁን ይክፈቱ' },
      { command: 'orders', description: 'የኔ ትዕዛዞች' },
      { command: 'help', description: 'ስልክ እና አድራሻ' },
      { command: 'news', description: 'የአዲስ ዕቃ መልዕክት ጀምር' },
      { command: 'stop', description: 'የአዲስ ዕቃ መልዕክት አቁም' },
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
  // Don't print the secret part of the webhook address
  console.log(`  webhook: ${(info.url ?? '').replace(/[^/]+$/, '••••••')}`);
  if (info.last_error_message) console.log(`  last delivery error: ${info.last_error_message}`);

  // Check that the server actually has this webhook path (it only does when its own
  // TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_TOKEN match this machine's .env)
  const probe = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (!probe) console.log('  ⚠ could not reach the API to verify the webhook');
  else if (probe.status === 404)
    console.log(
      '  ✗ The server has no route for this webhook. In Render → Environment, set TELEGRAM_WEBHOOK_SECRET to the same value as\n' +
        '    this .env, and TELEGRAM_BOT_TOKEN to this bot’s token. Wait for the redeploy, then run this script again.',
    );
  else console.log('  ✓ server is listening for this webhook');
  console.log(`  menu button → ${env.clientUrl}`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

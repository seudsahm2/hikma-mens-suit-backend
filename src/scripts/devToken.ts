/**
 * Development helper: prints a customer token for a fake Telegram user, so the API can be
 * tested without the Telegram app.  npx tsx src/scripts/devToken.ts [telegramId]
 */
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { signToken } from '../lib/auth';

async function main() {
  if (env.isProd) throw new Error('Not available in production');
  const telegramId = BigInt(process.argv[2] ?? '777');
  const user = await prisma.user.upsert({
    where: { telegramId },
    create: { telegramId, fullName: 'Test Buyer', telegramUsername: 'test_buyer' },
    update: {},
  });
  process.stdout.write(signToken({ sub: user.id, role: 'CUSTOMER' }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

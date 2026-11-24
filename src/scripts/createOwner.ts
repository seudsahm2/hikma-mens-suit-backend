/**
 * Creates (or resets) the single OWNER account from OWNER_NAME / OWNER_PHONE / OWNER_PASSWORD.
 *   npm run owner:create
 */
import '../config/loadEnv';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { normalizeEthiopianPhone } from '../lib/phone';

const prisma = new PrismaClient();

async function main() {
  const name = process.env.OWNER_NAME?.trim() || 'Owner';
  const phone = normalizeEthiopianPhone(process.env.OWNER_PHONE ?? '');
  const password = process.env.OWNER_PASSWORD ?? '';
  if (!phone) throw new Error('OWNER_PHONE must be a valid Ethiopian phone number');
  if (password.length < 10) throw new Error('OWNER_PASSWORD must be at least 10 characters');

  const otherOwner = await prisma.user.findFirst({ where: { role: 'OWNER', NOT: { phone } } });
  if (otherOwner) throw new Error(`An owner already exists (${otherOwner.phone}). Only one owner is allowed.`);

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { phone },
    create: { role: 'OWNER', fullName: name, phone, passwordHash },
    update: { role: 'OWNER', fullName: name, passwordHash, isActive: true },
  });
  console.log(`✓ Owner ready: ${user.fullName} (${user.phone}). Remove OWNER_PASSWORD from .env now.`);
}

main()
  .catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

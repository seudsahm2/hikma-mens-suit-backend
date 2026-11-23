/**
 * Seeds store configuration: categories, payment methods, delivery options, settings.
 * Safe to re-run — existing rows are kept (new categories/methods are added).
 *
 *   npm run db:seed                 → configuration
 *   npm run db:seed -- --clear-demo → also removes old demo products (tagged "demo")
 *
 * Products come from the Telegram channel import: npm run import:telegram
 */
import { PrismaClient } from '@prisma/client';
import { categories, defaultReturnPolicy, deliveryOptions, paymentMethods } from './data';

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));

async function seedConfig() {
  for (const [i, c] of categories.entries()) {
    const data = { nameEn: c.nameEn, nameAm: c.nameAm, kind: c.kind, sizes: c.sizes, sizeGuide: c.sizeGuide ?? undefined, sortOrder: i };
    // Existing categories keep owner edits except ordering
    await prisma.category.upsert({ where: { slug: c.slug }, create: { slug: c.slug, ...data }, update: { sortOrder: i } });
  }
  for (const [i, m] of paymentMethods.entries()) {
    const defaults =
      m.id === 'telebirr'
        ? { isEnabled: true, accountName: 'Hikma', accountNumber: '0955706969' } // confirm with owner
        : m.id === 'cash'
          ? { isEnabled: true }
          : {};
    await prisma.paymentMethod.upsert({
      where: { id: m.id },
      create: { id: m.id, name: m.name, kind: m.kind, sortOrder: i, ...defaults },
      update: { name: m.name, kind: m.kind },
    });
  }
  for (const d of deliveryOptions) {
    await prisma.deliveryOption.upsert({ where: { id: d.id }, create: d, update: {} });
  }
  await prisma.settings.upsert({
    where: { id: 'default' },
    create: { id: 'default', returnPolicyEn: defaultReturnPolicy.en, returnPolicyAm: defaultReturnPolicy.am },
    update: {},
  });
  console.log(`✓ store configuration (${categories.length} categories, ${paymentMethods.length} payment methods)`);
}

async function clearDemo() {
  const { deleteImage } = await import('../src/lib/storage');
  const products = await prisma.product.findMany({ where: { tags: { has: 'demo' } }, include: { images: true } });
  let archived = 0;
  for (const p of products) {
    if (await prisma.orderItem.count({ where: { productId: p.id } })) {
      await prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED' } });
      archived++;
      continue;
    }
    await prisma.product.delete({ where: { id: p.id } });
    await Promise.all(p.images.map((i) => deleteImage(i.key)));
  }
  console.log(`✓ removed ${products.length - archived} demo products${archived ? `, archived ${archived} that have orders` : ''}`);
}

async function main() {
  await seedConfig();
  if (args.has('--clear-demo')) await clearDemo();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

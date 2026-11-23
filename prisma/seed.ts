/**
 * Seeds store configuration (categories, payment methods, delivery options, settings).
 *
 *   npm run db:seed                 → configuration only (safe to re-run)
 *   npm run db:seed -- --demo       → + demo products cropped from TikTok reference frames
 *   npm run db:seed -- --clear-demo → removes demo products
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PrismaClient, type Prisma } from '@prisma/client';
import { categories, defaultReturnPolicy, deliveryOptions, paymentMethods } from './data';

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));

async function seedConfig() {
  for (const [i, c] of categories.entries()) {
    const data = { nameEn: c.nameEn, nameAm: c.nameAm, kind: c.kind, sizes: c.sizes, sizeGuide: c.sizeGuide ?? undefined, sortOrder: i };
    await prisma.category.upsert({ where: { slug: c.slug }, create: { slug: c.slug, ...data }, update: {} });
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
  console.log('✓ store configuration');
}

// ─── Demo catalogue ──────────────────────────────────────

const REF_DIR = path.resolve(__dirname, '../../docs/reference/tiktok');

type Crop = [file: string, left: number, top: number, width: number, height: number];

interface DemoProduct {
  nameEn: string;
  nameAm?: string;
  category: string;
  brand?: string;
  price: number;
  compareAt?: number;
  origin?: string;
  material?: string;
  fit?: string;
  featured?: boolean;
  description?: string;
  fragrance?: Partial<Prisma.ProductCreateInput>;
  variants: { size?: string; color?: string; hex?: string; stock: number }[];
  images: { crop: Crop; color?: string }[];
}

const demo: DemoProduct[] = [
  {
    nameEn: 'Tipped Knit Polo',
    nameAm: 'ኒት ፖሎ',
    category: 'polos',
    price: 5500,
    origin: 'Turkey',
    material: 'Cotton knit',
    fit: 'Regular',
    featured: true,
    description: 'Fine-gauge knit with contrast tipping on collar and sleeves.',
    variants: ['M', 'L', 'XL', 'XXL'].flatMap((size) => [
      { size, color: 'White', hex: '#F2F0EB', stock: 4 },
      { size, color: 'Black', hex: '#141414', stock: size === 'XXL' ? 1 : 5 },
    ]),
    images: [
      { crop: ['15.jpg', 70, 345, 500, 625], color: 'White' },
      { crop: ['10.jpg', 70, 345, 500, 625], color: 'Black' },
    ],
  },
  {
    nameEn: 'Classic Piqué Polo',
    category: 'polos',
    price: 5000,
    origin: 'Turkey',
    material: 'Cotton piqué',
    fit: 'Regular',
    variants: ['M', 'L', 'XL'].map((size) => ({ size, color: 'Charcoal', hex: '#2B2D31', stock: 6 })),
    images: [{ crop: ['5.jpg', 50, 300, 500, 625] }],
  },
  {
    nameEn: 'Slim Polo',
    category: 'polos',
    price: 5000,
    origin: 'Turkey',
    fit: 'Slim',
    variants: ['S', 'M', 'L', 'XL'].map((size) => ({ size, color: 'Stone Grey', hex: '#8E8D88', stock: 3 })),
    images: [{ crop: ['3.jpg', 330, 400, 299, 374] }],
  },
  {
    nameEn: 'Washed Slim Jeans',
    nameAm: 'ጂንስ ሱሪ',
    category: 'jeans',
    price: 6500,
    origin: 'Turkey',
    material: 'Stretch denim',
    fit: 'Slim',
    featured: true,
    variants: ['30', '31', '32', '33', '34', '36'].map((size) => ({ size, color: 'Washed Grey', hex: '#5E6369', stock: 3 })),
    images: [{ crop: ['18.jpg', 50, 250, 540, 675] }],
  },
  {
    nameEn: 'Striped Oxford Shirt',
    nameAm: 'ሸሚዝ',
    category: 'shirts',
    price: 5500,
    origin: 'Turkey',
    material: '100% cotton',
    fit: 'Slim',
    featured: true,
    variants: ['M', 'L', 'XL', 'XXL'].map((size) => ({ size, color: 'Rose Stripe', hex: '#C9727F', stock: 4 })),
    images: [{ crop: ['11.jpg', 345, 150, 284, 355] }],
  },
  {
    nameEn: 'Black Denim Jacket',
    nameAm: 'ጃኬት',
    category: 'jackets',
    price: 9500,
    origin: 'Turkey',
    material: 'Denim',
    fit: 'Regular',
    variants: ['M', 'L', 'XL'].map((size) => ({ size, color: 'Black', hex: '#1A1A1A', stock: 2 })),
    images: [{ crop: ['1.jpg', 245, 200, 240, 300] }],
  },
  {
    nameEn: 'Skechers Max Cushioning',
    category: 'shoes',
    brand: 'Skechers',
    price: 35000,
    featured: true,
    description: 'Original Skechers. Comfortable for every day.',
    variants: ['40', '41', '42', '43', '44', '45'].map((size) => ({ size, color: 'White', hex: '#F4F4F2', stock: 2 })),
    images: [{ crop: ['17.jpg', 0, 660, 629, 470] }],
  },
  {
    nameEn: 'Frankel Black Elixir',
    category: 'perfumes',
    brand: 'Assaf',
    price: 6500,
    featured: true,
    fragrance: { concentration: 'EDP', volumeMl: 100, scentFamily: 'Woody', notesTop: ['Bergamot'], notesHeart: ['Lavender'], notesBase: ['Vanilla', 'Amber'] },
    variants: [{ stock: 8 }],
    images: [{ crop: ['13.jpg', 110, 280, 260, 325] }],
  },
  {
    nameEn: 'Wild Colt',
    category: 'perfumes',
    price: 4800,
    fragrance: { concentration: 'EDP', volumeMl: 100, scentFamily: 'Fresh', notesTop: ['Citrus'], notesHeart: ['Marine'], notesBase: ['Musk'] },
    variants: [{ stock: 6 }],
    images: [{ crop: ['14.jpg', 20, 300, 260, 325] }],
  },
  {
    nameEn: 'Oud Octagon Parfum',
    category: 'perfumes',
    price: 12000,
    fragrance: { concentration: 'Parfum', volumeMl: 100, scentFamily: 'Oud', notesTop: ['Saffron'], notesHeart: ['Rose'], notesBase: ['Oud', 'Amber'] },
    variants: [{ stock: 3 }],
    images: [{ crop: ['16.jpg', 110, 500, 460, 460] }],
  },
  {
    nameEn: 'Emerald Soul Diamond',
    category: 'perfumes',
    brand: 'Ibraq',
    price: 5500,
    fragrance: { concentration: 'EDP', volumeMl: 100, scentFamily: 'Aromatic' },
    variants: [{ stock: 10 }],
    images: [{ crop: ['6.jpg', 320, 120, 309, 560] }],
  },
];

async function seedDemo() {
  if (!existsSync(REF_DIR)) {
    console.warn(`! ${REF_DIR} not found — skipping demo products`);
    return;
  }
  // Imported here so seeding config never needs storage env
  const { saveImage } = await import('../src/lib/storage');
  const { slugify } = await import('../src/lib/slug');

  for (const d of demo) {
    const slug = slugify(d.nameEn);
    if (await prisma.product.findUnique({ where: { slug } })) continue;
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: d.category } });
    const brand = d.brand
      ? await prisma.brand.upsert({ where: { slug: slugify(d.brand) }, create: { slug: slugify(d.brand), name: d.brand }, update: {} })
      : null;

    const product = await prisma.product.create({
      data: {
        slug,
        nameEn: d.nameEn,
        nameAm: d.nameAm,
        descriptionEn: d.description,
        categoryId: category.id,
        brandId: brand?.id,
        origin: d.origin,
        material: d.material,
        fit: d.fit,
        basePrice: d.price,
        compareAtPrice: d.compareAt,
        costPrice: Math.round(d.price * 0.7),
        status: 'ACTIVE',
        isFeatured: Boolean(d.featured),
        tags: ['demo'],
        ...(d.fragrance as object),
        variants: {
          create: d.variants.map((v, i) => ({
            sku: `DEMO-${slug.slice(0, 16).toUpperCase()}-${i}`,
            size: v.size ?? '',
            color: v.color ?? '',
            colorHex: v.hex,
            stock: v.stock,
          })),
        },
      },
    });

    for (const [i, img] of d.images.entries()) {
      const [file, left, top, width, height] = img.crop;
      const buf = await sharp(path.join(REF_DIR, file)).extract({ left, top, width, height }).toBuffer();
      const saved = await saveImage(buf, 'products');
      await prisma.productImage.create({
        data: { productId: product.id, key: saved.key, width: saved.width, height: saved.height, color: img.color, sortOrder: i, alt: d.nameEn },
      });
    }
    console.log(`  + ${d.nameEn}`);
  }
  console.log('✓ demo products');
}

async function clearDemo() {
  const { deleteImage } = await import('../src/lib/storage');
  const products = await prisma.product.findMany({ where: { tags: { has: 'demo' } }, include: { images: true } });
  for (const p of products) {
    const ordered = await prisma.orderItem.count({ where: { productId: p.id } });
    if (ordered) {
      await prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED' } });
      continue;
    }
    await prisma.product.delete({ where: { id: p.id } });
    await Promise.all(p.images.map((i) => deleteImage(i.key)));
  }
  console.log(`✓ removed ${products.length} demo products`);
}

async function main() {
  await seedConfig();
  if (args.has('--demo')) await seedDemo();
  if (args.has('--clear-demo')) await clearDemo();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

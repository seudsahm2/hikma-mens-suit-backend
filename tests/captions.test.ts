import { describe, expect, it } from 'vitest';
import { buildCaption } from '../src/modules/telegram/captions';
import { parseCaption } from '../src/scripts/importTelegram';

const contact = { inbox: 'Hikm5506', phone: '0955706969', addressAm: 'ቤተል ቢጫ ፎቅ፣ ፊትለፊት MK ህንፃ፣ ሱቅ ቁጥር G2' };

describe('buildCaption', () => {
  it('uses the real brand on shoe posts (never "Adidas" on Skechers)', () => {
    const c = buildCaption({ ...contact, kind: 'FOOTWEAR', nameEn: 'Go Walk', brand: 'Skechers', price: 35000, sizes: ['41', '42'], freeDelivery: true });
    expect(c).toContain('👟🔥 SKECHERS 🔥👟');
    expect(c).toContain('ኦሪጂናል Skechers ጫማ');
    expect(c).toContain('SKECHERS ORIGINAL');
    expect(c).not.toMatch(/adidas|አዲዳስ/i);
    expect(c).toContain('35,000 ብር');
    expect(c).toContain('📏 Size: 41 · 42');
  });

  it('follows the clothing format with origin flag', () => {
    const c = buildCaption({ ...contact, kind: 'APPAREL', nameEn: 'Knit Polo', price: 5500, origin: 'Turkey', sizes: [], freeDelivery: true });
    expect(c.startsWith('✨ Made in Turkey 🇹🇷 ✨')).toBe(true);
    expect(c).toContain('💰 ዋጋ: 5,500ብር');
    expect(c).toContain('📍 አድራሻ:');
  });
});

describe('parseCaption (Telegram import)', () => {
  it('reads brand from the title line, not the mislabelled body', () => {
    const p = parseCaption('👟🔥 SKECHERS🔥👟\n\n💯 ኦሪጂናል አዲዳስ ጫማ\n\n💰 ዋጋ፡ 35,000 ብር\n\n✨ ADIDAS ORIGINAL');
    expect(p).toMatchObject({ brand: 'Skechers', price: 35000, categorySlug: 'shoes' });
  });

  it('detects origin, price and suits', () => {
    const p = parseCaption('🔥 Hikma Men’s Fashion 🔥\n\n👔 ጥራት ያለው የወንዶች ልብስ\n🚚 Free Delivery\n💰 ዋጋ: 25000ብር');
    expect(p).toMatchObject({ price: 25000, categorySlug: 'suits' });
    const q = parseCaption('✨ Made in Turkey 🇹🇷 ✨\n\n💰 ዋጋ: 5500ብር');
    expect(q).toMatchObject({ origin: 'Turkey', price: 5500, categorySlug: 'shirts' });
  });
});

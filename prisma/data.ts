import type { ProductKind } from '@prisma/client';

export const categories: {
  slug: string;
  nameEn: string;
  nameAm: string;
  kind: ProductKind;
  sizes: string[];
  sizeGuide?: Record<string, string>[];
}[] = [
  {
    slug: 'suits',
    nameEn: 'Suits',
    nameAm: 'ሱፍ',
    kind: 'APPAREL',
    sizes: ['44', '46', '48', '50', '52', '54', '56', '58'],
    sizeGuide: [
      { size: '46', chest: '92', waist: '80', height: '170–176' },
      { size: '48', chest: '96', waist: '84', height: '172–178' },
      { size: '50', chest: '100', waist: '88', height: '174–180' },
      { size: '52', chest: '104', waist: '92', height: '176–182' },
      { size: '54', chest: '108', waist: '96', height: '178–184' },
      { size: '56', chest: '112', waist: '100', height: '180–186' },
    ],
  },
  {
    slug: 'shirts',
    nameEn: 'Shirts',
    nameAm: 'ሸሚዝ',
    kind: 'APPAREL',
    sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'],
    sizeGuide: [
      { size: 'S', chest: '88–92', collar: '37–38' },
      { size: 'M', chest: '96–100', collar: '39–40' },
      { size: 'L', chest: '104–108', collar: '41–42' },
      { size: 'XL', chest: '112–116', collar: '43–44' },
      { size: 'XXL', chest: '120–124', collar: '45–46' },
    ],
  },
  {
    slug: 'polos',
    nameEn: 'Polos & Tees',
    nameAm: 'ፖሎ እና ቲሸርት',
    kind: 'APPAREL',
    sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'],
    sizeGuide: [
      { size: 'S', chest: '88–92' },
      { size: 'M', chest: '96–100' },
      { size: 'L', chest: '104–108' },
      { size: 'XL', chest: '112–116' },
      { size: 'XXL', chest: '120–124' },
    ],
  },
  { slug: 'knitwear', nameEn: 'Knitwear', nameAm: 'ሹራብ', kind: 'APPAREL', sizes: ['S', 'M', 'L', 'XL', 'XXL'] },
  { slug: 'jackets', nameEn: 'Jackets', nameAm: 'ጃኬት', kind: 'APPAREL', sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'] },
  { slug: 'sets', nameEn: 'Sets & Tracksuits', nameAm: 'ሙሉ ልብስ እና ትራክሱት', kind: 'APPAREL', sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'] },
  { slug: 'jelabiya', nameEn: 'Jelabiya & Kaftan', nameAm: 'ጀለቢያ', kind: 'APPAREL', sizes: ['S', 'M', 'L', 'XL', 'XXL', '3XL'] },
  {
    slug: 'jeans',
    nameEn: 'Jeans & Trousers',
    nameAm: 'ጂንስ እና ሱሪ',
    kind: 'APPAREL',
    sizes: ['28', '29', '30', '31', '32', '33', '34', '36', '38', '40'],
    sizeGuide: [
      { size: '30', waist: '76' },
      { size: '31', waist: '79' },
      { size: '32', waist: '81' },
      { size: '33', waist: '84' },
      { size: '34', waist: '86' },
      { size: '36', waist: '91' },
      { size: '38', waist: '97' },
    ],
  },
  {
    slug: 'shoes',
    nameEn: 'Shoes',
    nameAm: 'ጫማ',
    kind: 'FOOTWEAR',
    sizes: ['39', '40', '41', '42', '43', '44', '45', '46'],
    sizeGuide: [
      { size: '40', foot: '25.5' },
      { size: '41', foot: '26' },
      { size: '42', foot: '26.5' },
      { size: '43', foot: '27.5' },
      { size: '44', foot: '28' },
      { size: '45', foot: '29' },
    ],
  },
  { slug: 'perfumes', nameEn: 'Perfumes', nameAm: 'ሽቶ', kind: 'FRAGRANCE', sizes: [] },
  { slug: 'accessories', nameEn: 'Watches & Accessories', nameAm: 'ሰዓት እና አክሰሰሪ', kind: 'ACCESSORY', sizes: [] },
];

/** Every common Ethiopian wallet and bank. The owner enables the ones she uses and adds account numbers. */
export const paymentMethods: { id: string; name: string; kind: 'wallet' | 'bank' | 'cash' }[] = [
  { id: 'telebirr', name: 'telebirr', kind: 'wallet' },
  { id: 'cbe_birr', name: 'CBE Birr', kind: 'wallet' },
  { id: 'mpesa', name: 'M-Pesa', kind: 'wallet' },
  { id: 'ebirr', name: 'e-Birr', kind: 'wallet' },
  { id: 'cbe', name: 'Commercial Bank of Ethiopia', kind: 'bank' },
  { id: 'awash', name: 'Awash Bank', kind: 'bank' },
  { id: 'boa', name: 'Bank of Abyssinia', kind: 'bank' },
  { id: 'dashen', name: 'Dashen Bank', kind: 'bank' },
  { id: 'coop', name: 'Cooperative Bank of Oromia', kind: 'bank' },
  { id: 'hibret', name: 'Hibret Bank', kind: 'bank' },
  { id: 'wegagen', name: 'Wegagen Bank', kind: 'bank' },
  { id: 'nib', name: 'Nib International Bank', kind: 'bank' },
  { id: 'zemen', name: 'Zemen Bank', kind: 'bank' },
  { id: 'abay', name: 'Abay Bank', kind: 'bank' },
  { id: 'bunna', name: 'Bunna Bank', kind: 'bank' },
  { id: 'berhan', name: 'Berhan Bank', kind: 'bank' },
  { id: 'enat', name: 'Enat Bank', kind: 'bank' },
  { id: 'amhara', name: 'Amhara Bank', kind: 'bank' },
  { id: 'oromia', name: 'Oromia Bank', kind: 'bank' },
  { id: 'siinqee', name: 'Siinqee Bank', kind: 'bank' },
  { id: 'ahadu', name: 'Ahadu Bank', kind: 'bank' },
  { id: 'global', name: 'Global Bank Ethiopia', kind: 'bank' },
  { id: 'lion', name: 'Lion International Bank', kind: 'bank' },
  { id: 'zamzam', name: 'ZamZam Bank', kind: 'bank' },
  { id: 'hijra', name: 'Hijra Bank', kind: 'bank' },
  { id: 'tsehay', name: 'Tsehay Bank', kind: 'bank' },
  { id: 'gadaa', name: 'Gadaa Bank', kind: 'bank' },
  { id: 'cash', name: 'Pay at the shop / on delivery', kind: 'cash' },
];

export const deliveryOptions = [
  {
    id: 'addis',
    nameEn: 'Addis Ababa',
    nameAm: 'አዲስ አበባ',
    noteEn: 'Free delivery',
    noteAm: 'ነፃ ማድረስ',
    fee: 0,
    needsAddress: true,
    sortOrder: 0,
  },
  {
    id: 'regional',
    nameEn: 'Outside Addis',
    nameAm: 'ከአዲስ አበባ ውጪ',
    noteEn: 'Fee confirmed by phone',
    noteAm: 'ዋጋው በስልክ ይነገርዎታል',
    fee: null,
    needsAddress: true,
    sortOrder: 1,
  },
  {
    id: 'pickup',
    nameEn: 'Pick up at the shop',
    nameAm: 'ከሱቁ ይውሰዱ',
    noteEn: 'Betel · Shop G2',
    noteAm: 'ቤተል · ሱቅ G2',
    fee: 0,
    needsAddress: false,
    sortOrder: 2,
  },
];

export const defaultReturnPolicy = {
  en: 'Size exchange within 3 days — unworn, with tags and receipt.\nOpened perfumes cannot be returned.',
  am: 'ያልተለበሰ፣ መለያው ያልተነሳ ዕቃ በ3 ቀን ውስጥ በሌላ ሳይዝ መቀየር ይቻላል።\nየተከፈተ ሽቶ አይመለስም።',
};

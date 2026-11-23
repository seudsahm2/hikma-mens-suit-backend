import { prisma } from '../../lib/prisma';

export async function getSettings() {
  return prisma.settings.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} });
}

export async function getPublicConfig() {
  const [settings, paymentMethods, deliveryOptions] = await Promise.all([
    getSettings(),
    prisma.paymentMethod.findMany({ where: { isEnabled: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.deliveryOption.findMany({ where: { isEnabled: true }, orderBy: { sortOrder: 'asc' } }),
  ]);
  const { channelChatId: _c, adminChatId: _a, updatedAt: _u, ...publicSettings } = settings;
  return {
    store: publicSettings,
    paymentMethods: paymentMethods.map(({ id, name, kind, accountName, accountNumber }) => ({
      id,
      name,
      kind,
      accountName,
      accountNumber,
    })),
    deliveryOptions: deliveryOptions.map(({ id, nameEn, nameAm, noteEn, noteAm, fee, needsAddress }) => ({
      id,
      nameEn,
      nameAm,
      noteEn,
      noteAm,
      fee,
      needsAddress,
    })),
  };
}

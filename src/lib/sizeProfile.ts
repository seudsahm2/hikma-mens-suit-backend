import type { Prisma } from '@prisma/client';

/** What we remember about a customer's fit. Stored in User.sizeProfile. */
export interface SizeProfile {
  height?: number; // cm
  weight?: number; // kg
  fit?: 'slim' | 'regular' | 'loose';
  /** last size chosen per category slug */
  sizes: Record<string, string>;
}

export function readSizeProfile(v: Prisma.JsonValue | null | undefined): SizeProfile {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const sizes = o.sizes && typeof o.sizes === 'object' && !Array.isArray(o.sizes) ? (o.sizes as Record<string, string>) : {};
  const num = (x: unknown, min: number, max: number) => (typeof x === 'number' && x >= min && x <= max ? x : undefined);
  return {
    height: num(o.height, 120, 230),
    weight: num(o.weight, 35, 250),
    fit: o.fit === 'slim' || o.fit === 'regular' || o.fit === 'loose' ? o.fit : undefined,
    sizes: Object.fromEntries(Object.entries(sizes).filter(([k, s]) => typeof s === 'string' && k.length <= 60 && s.length <= 20).slice(0, 40)),
  };
}

export function mergeSizeProfile(current: Prisma.JsonValue | null | undefined, patch: Partial<SizeProfile>): Prisma.InputJsonValue {
  const base = readSizeProfile(current);
  const next: SizeProfile = { ...base, ...patch, sizes: { ...base.sizes, ...(patch.sizes ?? {}) } };
  return JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue;
}

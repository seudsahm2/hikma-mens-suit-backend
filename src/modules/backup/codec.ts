/**
 * JSON can't hold every database type exactly, so values that would change are tagged:
 * dates keep their exact instant, BigInt (Telegram ids) keeps every digit, bytes stay bytes.
 * Restoring with these gives back the same rows — same ids, same timestamps.
 */
type Tagged = { $d: string } | { $b: string } | { $x: string };

export function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return { $d: v.toISOString() };
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $x: Buffer.from(v).toString('base64') };
  return v;
}

export function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const t = v as Tagged;
    if ('$d' in t && Object.keys(t).length === 1) return new Date(t.$d);
    if ('$b' in t && Object.keys(t).length === 1) return BigInt(t.$b);
    if ('$x' in t && Object.keys(t).length === 1) return Buffer.from(t.$x, 'base64');
  }
  return v;
}

/** Only top-level column values are tagged; JSON columns (objects/arrays) are stored as they are. */
export const encodeRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encodeValue(v)]));
export const decodeRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decodeValue(v)]));

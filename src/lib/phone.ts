/** Normalises Ethiopian phone numbers to 09XXXXXXXX / 07XXXXXXXX. Returns null if invalid. */
export function normalizeEthiopianPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  let local: string;
  if (digits.startsWith('251') && digits.length === 12) local = `0${digits.slice(3)}`;
  else if (digits.length === 9 && /^[79]/.test(digits)) local = `0${digits}`;
  else local = digits;
  return /^0[79]\d{8}$/.test(local) ? local : null;
}

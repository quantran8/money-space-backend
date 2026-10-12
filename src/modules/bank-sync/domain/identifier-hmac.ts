import { createHmac } from 'node:crypto';

/** Digits only; rejects anything that is not a plausible full account number. */
export function normalizeAccountNumber(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  return /^\d{6,19}$/.test(digits) ? digits : null;
}

export function identifierHmac(
  key: Buffer,
  providerCode: string,
  normalized: string,
): string {
  return createHmac('sha256', key)
    .update(`${providerCode}:${normalized}`)
    .digest('hex');
}

export function last4(normalized: string): string {
  return normalized.slice(-4);
}

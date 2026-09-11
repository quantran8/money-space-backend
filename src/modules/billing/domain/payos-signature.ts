import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PayOS webhook signature.
 *
 * The scheme, exactly:
 *
 *   1. take the `data` OBJECT — **not** the whole body, and not the raw bytes;
 *   2. sort its keys alphabetically;
 *   3. join as `key=value&key=value…`;
 *   4. HMAC-SHA256 with the merchant's checksum key;
 *   5. compare, in constant time, with the body's `signature`.
 *
 * Signing `data` only is the part that is easy to get wrong: HMAC-ing the raw
 * request body — which is what most webhook schemes do — produces a digest that
 * never matches, and the failure looks identical to a forged request.
 *
 * `null` and `undefined` serialize as the EMPTY STRING rather than "null", and
 * objects/arrays as JSON. That is what PayOS's own implementation does, and a
 * mismatch here rejects genuine payments.
 */

/** One field, as it appears in the string that gets signed. */
function serialize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `amount=39000&description=OURSIGHT&…` — keys sorted, joined with `&`. */
export function buildSignaturePayload(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .map((key) => `${key}=${serialize(data[key])}`)
    .join('&');
}

export function signPayload(
  data: Record<string, unknown>,
  checksumKey: string,
): string {
  return createHmac('sha256', checksumKey)
    .update(buildSignaturePayload(data))
    .digest('hex');
}

/**
 * Whether `signature` is genuine for `data`.
 *
 * Compared with `timingSafeEqual` rather than `===`: a byte-by-byte comparison
 * that returns early leaks, through its own duration, how much of a guess was
 * correct — which is enough to forge a signature one byte at a time. The length
 * check first is safe, because the length of a hex SHA-256 digest is public.
 */
export function verifySignature(
  data: Record<string, unknown> | null | undefined,
  signature: string | null | undefined,
  checksumKey: string,
): boolean {
  // A body with no data or no signature is not a failed verification, it is
  // not a signed message at all.
  if (!data || !signature || !checksumKey) return false;

  const expected = signPayload(data, checksumKey);
  if (expected.length !== signature.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    // Non-hex or otherwise unpaired buffers. Treated as a failed signature
    // rather than an error: a malformed signature IS an invalid one.
    return false;
  }
}

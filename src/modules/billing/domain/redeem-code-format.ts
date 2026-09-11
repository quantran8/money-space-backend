import { randomFillSync } from 'crypto';

/**
 * Crockford Base32: 32 characters with `I`, `L`, `O` and `U` removed.
 *
 * `I`/`L` are read as 1, `O` as 0, and dropping `U` keeps the generator from
 * spelling anything unfortunate. This is a published alphabet rather than an
 * invented one, so the normalization rules below are the standard's, not
 * guesses.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PREFIX = 'OURS';
/** 7 random characters (35 bits) + 1 checksum. */
const RANDOM_LENGTH = 7;
const BODY_LENGTH = RANDOM_LENGTH + 1;

/** A normalized code: `OURS` followed by 8 alphabet characters. */
const NORMALIZED_PATTERN = new RegExp(
  `^${PREFIX}[${CODE_ALPHABET}]{${BODY_LENGTH}}$`,
);

/**
 * Check character: the alphabet letter at (sum of the other indices) mod 32.
 *
 * Its job is UX, not security. One mistyped character is caught client-side 31
 * times out of 32 — no request, and no rate-limit attempt spent — so a typo
 * says "that code isn't right" instantly instead of after a round trip.
 */
function checksum(body: string): string {
  let total = 0;
  for (const char of body) total += CODE_ALPHABET.indexOf(char);
  return CODE_ALPHABET[total % CODE_ALPHABET.length];
}

/**
 * Fold whatever was typed or pasted into the canonical form.
 *
 * Runs on the way in AND on the way out, so a code is stored exactly as it will
 * later be looked up.
 *
 * The confusable mapping is the important part for a Vietnamese audience:
 * codes arrive as a screenshot in a Zalo message and get typed by hand, so
 * someone entering `OURS-O1I2-3456` — reading the letter O — still matches the
 * stored `OURS01123456`.
 */
export function normalizeRedeemCode(raw: string): string {
  const cleaned = (raw ?? '')
    .toUpperCase()
    // Strip separators, spaces, and the zero-width characters a copy from a
    // chat app tends to bring along.
    .replace(/[^0-9A-Z]/g, '');

  // The prefix is a word, not payload, and it contains two of the very letters
  // the fold rewrites — `OURS` would become `0VRS` and never match anything.
  // So fold the BODY only, and leave a correct prefix alone.
  if (!cleaned.startsWith(PREFIX)) return cleaned;

  const body = cleaned
    .slice(PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');

  return `${PREFIX}${body}`;
}

/** Whether a normalized code is well-formed AND its check character agrees. */
export function isValidRedeemCode(normalized: string): boolean {
  if (!NORMALIZED_PATTERN.test(normalized)) return false;

  const body = normalized.slice(PREFIX.length);
  return checksum(body.slice(0, RANDOM_LENGTH)) === body[RANDOM_LENGTH];
}

/** `OURS01123456` → `OURS-0112-3456`, for display only. */
export function formatRedeemCode(normalized: string): string {
  if (!NORMALIZED_PATTERN.test(normalized)) return normalized;
  const body = normalized.slice(PREFIX.length);
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** One code. Uses `randomFillSync`, never `Math.random`. */
export function generateRedeemCode(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  randomFillSync(bytes);

  let body = '';
  for (const byte of bytes) {
    // 32 divides 256 exactly, so masking introduces no modulo bias.
    body += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }

  return `${PREFIX}${body}${checksum(body)}`;
}

/** `count` codes, guaranteed distinct within the batch. */
export function generateRedeemCodes(count: number): string[] {
  const codes = new Set<string>();
  // Bounded so a bad alphabet or a broken RNG fails loudly instead of hanging.
  const maxAttempts = count * 10 + 100;

  let attempts = 0;
  while (codes.size < count && attempts < maxAttempts) {
    codes.add(generateRedeemCode());
    attempts += 1;
  }

  if (codes.size < count) {
    throw new Error(`Could not generate ${count} distinct codes`);
  }
  return [...codes];
}

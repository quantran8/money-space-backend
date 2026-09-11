/**
 * The machine-readable reason an request was refused.
 *
 * A thrown `message` is a diagnostic — English, sometimes carrying an id or a
 * Prisma/Supabase detail — and the client never displays it. When the client has
 * to BEHAVE differently (open the paywall, send the user back to sign in, offer
 * a reassign flow), that decision hangs off one of these codes instead.
 *
 * Not every throw site needs one: the default copy covers an ordinary refusal.
 * Add a code only when a client would branch on it. See memory/error-handling.md.
 */
export type ErrorCode =
  // Auth — the client signs the user out or resends a verification mail.
  | 'unauthenticated'
  | 'session_expired'
  | 'invalid_credentials'
  | 'email_unverified'
  // Access — a non-member, or a member who is not the creator.
  | 'forbidden'
  | 'not_household_member'
  | 'not_household_creator'
  // Shape of the request itself.
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  // Domain refusals a client offers a way out of.
  | 'asset_in_use'
  | 'rate_limited'
  | 'upstream_unavailable';

/** Runtime mirror of the union, for validating a value off the wire. */
export const ERROR_CODES: readonly ErrorCode[] = [
  'unauthenticated',
  'session_expired',
  'invalid_credentials',
  'email_unverified',
  'forbidden',
  'not_household_member',
  'not_household_creator',
  'not_found',
  'validation_failed',
  'conflict',
  'asset_in_use',
  'rate_limited',
  'upstream_unavailable',
] as const;

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
  );
}

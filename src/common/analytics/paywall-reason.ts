/**
 * Which wall a household hit, in one place.
 *
 * This existed three times before, and no two copies agreed: the server threw
 * eight, `paywall-store.ts` declared ten, and `query-client.ts` kept a
 * hand-written array of nine that omitted `manage` and included `trial_ending`
 * — a value the server can never send. See [[analytics]].
 *
 * The split is real, not accidental: `trial_ending` and `manage` are entries
 * the CLIENT opens with nothing refused, so no 402 can carry them. Keeping two
 * names for the two ideas is what stops them drifting back apart.
 */

/** A wall the SERVER refused at. Every 402 carries exactly one of these. */
export type PaywallReason =
  | 'goal_quota'
  | 'whatif_quota'
  | 'auto_price_quota'
  | 'forecast_horizon'
  | 'history'
  | 'export'
  | 'expired'
  | 'general';

/** Runtime mirror of the union, for validating a value off the wire. */
export const PAYWALL_REASONS: readonly PaywallReason[] = [
  'goal_quota',
  'whatif_quota',
  'auto_price_quota',
  'forecast_horizon',
  'history',
  'export',
  'expired',
  'general',
] as const;

/**
 * Opened by the client with nothing refused: a trial running out, or a Premium
 * household opening the sheet to look at its plan.
 */
export type ClientOnlyPaywallEntry = 'trial_ending' | 'manage';

/**
 * Every way the paywall can open — what analytics counts. A strict superset of
 * `PaywallReason`, so a 402 reason is always a valid entry.
 */
export type PaywallEntry = PaywallReason | ClientOnlyPaywallEntry;

export function isPaywallReason(value: unknown): value is PaywallReason {
  return (
    typeof value === 'string' &&
    (PAYWALL_REASONS as readonly string[]).includes(value)
  );
}

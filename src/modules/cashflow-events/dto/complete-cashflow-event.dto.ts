export interface CompleteCashflowEventDto {
  /**
   * Which occurrence is being completed. Defaults to the record's current
   * `expectedDate`. Used as the idempotency key so a double-tap cannot advance
   * a recurring series twice.
   */
  occurrenceDate?: string;
  /** What was actually moved. Defaults to the planned `amount`. */
  amount?: number;
  /** The wallet debited (outgoing) or credited (incoming). */
  assetId?: string;
  note?: string;
}

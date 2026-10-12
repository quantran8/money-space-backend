/**
 * Bank notification sync secrets. Getters, not values — see billing.config.ts
 * for why. Keys are 32 random bytes, hex or base64. See memory/bank-sync.md.
 */
function key(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  // 64 hex chars (`openssl rand -hex 32`) or base64 (`openssl rand -base64 32`).
  const buf = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  return buf.length === 32 ? buf : null;
}

export const bankSyncConfig = {
  /** HMAC key for account identifiers. Rotating it orphans every source. */
  get hmacKey(): Buffer | null {
    return key(process.env.BANK_SYNC_HMAC_KEY);
  },

  /** AES-256-GCM key for raw notification payloads. */
  get payloadKey(): Buffer | null {
    return key(process.env.BANK_SYNC_PAYLOAD_KEY);
  },

  /**
   * Keep the encrypted original for re-parsing. Off = only the HMAC fingerprint
   * is stored and the payload key is not needed. See memory/bank-sync.md.
   */
  get storeRawPayload(): boolean {
    return process.env.BANK_SYNC_STORE_RAW_PAYLOAD !== 'false';
  },

  get configured(): boolean {
    return (
      bankSyncConfig.hmacKey !== null &&
      (!bankSyncConfig.storeRawPayload || bankSyncConfig.payloadKey !== null)
    );
  },

  get rawRetentionDays(): number {
    const days = Number(process.env.BANK_SYNC_RAW_RETENTION_DAYS ?? 30);
    return Number.isFinite(days) && days > 0 ? days : 30;
  },

  get ratePerMinute(): number {
    const n = Number(process.env.BANK_SYNC_RATE_PER_MINUTE ?? 30);
    return Number.isFinite(n) && n > 0 ? n : 30;
  },
};

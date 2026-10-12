import { randomBytes } from 'node:crypto';
import { bankSyncConfig } from './bank-sync.config';

describe('bankSyncConfig keys', () => {
  afterEach(() => delete process.env.BANK_SYNC_HMAC_KEY);

  it.each([
    ['hex', randomBytes(32).toString('hex')],
    ['base64', randomBytes(32).toString('base64')],
  ])('accepts a 32-byte %s key', (_name, value) => {
    process.env.BANK_SYNC_HMAC_KEY = value;
    expect(bankSyncConfig.hmacKey?.length).toBe(32);
  });

  it('rejects a key of the wrong size', () => {
    process.env.BANK_SYNC_HMAC_KEY = randomBytes(16).toString('hex');
    expect(bankSyncConfig.hmacKey).toBeNull();
  });
});

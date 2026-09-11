import { verifyWebhookAuth } from './revenuecat-auth';

const SECRET = 'rc-webhook-secret-value';

describe('RevenueCat webhook authorization', () => {
  it('accepts the configured secret', () => {
    expect(verifyWebhookAuth(SECRET, SECRET)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyWebhookAuth('not-the-secret', SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookAuth(undefined, SECRET)).toBe(false);
  });

  /**
   * The case that matters most: a deploy that forgot the variable must refuse
   * every delivery rather than granting Premium to anyone who finds the URL.
   */
  it('refuses everything when no secret is configured', () => {
    expect(verifyWebhookAuth('anything', '')).toBe(false);
    expect(verifyWebhookAuth('', '')).toBe(false);
    expect(verifyWebhookAuth(undefined, '')).toBe(false);
  });

  /** Hashing first means a length mismatch cannot throw out of timingSafeEqual. */
  it('handles a guess of a different length without throwing', () => {
    expect(() => verifyWebhookAuth('short', SECRET)).not.toThrow();
    expect(verifyWebhookAuth('short', SECRET)).toBe(false);
  });
});

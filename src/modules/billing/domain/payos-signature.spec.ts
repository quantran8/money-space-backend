import { createHmac } from 'node:crypto';
import {
  buildSignaturePayload,
  signPayload,
  verifySignature,
} from './payos-signature';

const KEY = 'test-checksum-key';

/** A realistic PayOS `data` object. */
function data(over: Record<string, unknown> = {}) {
  return {
    orderCode: 175735680042,
    amount: 39000,
    description: 'OURSIGHT',
    accountNumber: '12345678',
    reference: 'FT25001234567',
    transactionDateTime: '2026-09-07 14:32:11',
    currency: 'VND',
    paymentLinkId: 'a1b2c3d4e5',
    code: '00',
    desc: 'success',
    ...over,
  };
}

describe('PayOS signature', () => {
  describe('the string that gets signed', () => {
    it('sorts keys alphabetically, whatever order they arrive in', () => {
      // The object key order in a JSON body is not guaranteed, so the sort is
      // what makes the digest reproducible at all.
      const forwards = buildSignaturePayload({ a: 1, b: 2, c: 3 });
      const backwards = buildSignaturePayload({ c: 3, b: 2, a: 1 });

      expect(forwards).toBe('a=1&b=2&c=3');
      expect(backwards).toBe(forwards);
    });

    it('writes null and undefined as EMPTY, never as "null"', () => {
      // PayOS's own implementation does this. Writing the string "null" here
      // would reject genuine payments whose optional fields came back empty.
      expect(buildSignaturePayload({ a: null, b: undefined, c: 1 })).toBe(
        'a=&b=&c=1',
      );
    });

    it('serializes nested objects and arrays as JSON', () => {
      expect(buildSignaturePayload({ a: [1, 2], b: { x: 1 } })).toBe(
        'a=[1,2]&b={"x":1}',
      );
    });
  });

  describe('verification', () => {
    it('accepts a signature produced by the documented scheme', () => {
      // Built here from first principles rather than by calling signPayload,
      // so the test would still catch the implementation changing its own
      // definition of correct.
      const payload = data();
      const expected = createHmac('sha256', KEY)
        .update(
          Object.keys(payload)
            .sort()
            .map((key) => `${key}=${String(payload[key as keyof typeof payload])}`)
            .join('&'),
        )
        .digest('hex');

      expect(verifySignature(payload, expected, KEY)).toBe(true);
    });

    it('signs `data` ONLY — never the whole body', () => {
      // The mistake this guards against: HMAC-ing the entire request body,
      // which is what most webhook schemes do. It produces a digest that never
      // matches, and the failure looks exactly like a forged request.
      const payload = data();
      const wholeBody = { code: '00', desc: 'success', data: payload };

      const overData = signPayload(payload, KEY);
      const overBody = signPayload(wholeBody as Record<string, unknown>, KEY);

      expect(overData).not.toBe(overBody);
      expect(verifySignature(payload, overBody, KEY)).toBe(false);
    });

    it('rejects a payload altered by one byte', () => {
      const signature = signPayload(data(), KEY);
      // The amount is the field an attacker would actually change.
      expect(verifySignature(data({ amount: 1 }), signature, KEY)).toBe(false);
    });

    it('rejects a signature made with a different checksum key', () => {
      const forged = signPayload(data(), 'not-the-real-key');
      expect(verifySignature(data(), forged, KEY)).toBe(false);
    });

    it('rejects a missing signature, missing data, or missing key', () => {
      const signature = signPayload(data(), KEY);

      expect(verifySignature(data(), null, KEY)).toBe(false);
      expect(verifySignature(data(), '', KEY)).toBe(false);
      expect(verifySignature(null, signature, KEY)).toBe(false);
      // An unconfigured checksum key must never verify as valid — otherwise a
      // misconfigured deploy would accept every forged webhook.
      expect(verifySignature(data(), signature, '')).toBe(false);
    });

    it('rejects a signature of the wrong length without throwing', () => {
      // `timingSafeEqual` throws on unequal buffer lengths, so this would be an
      // unhandled error in the webhook rather than a rejection.
      expect(verifySignature(data(), 'abc', KEY)).toBe(false);
      expect(() => verifySignature(data(), 'abc', KEY)).not.toThrow();
    });

    it('rejects a non-hex signature of the right length without throwing', () => {
      const right = signPayload(data(), KEY);
      const garbage = 'z'.repeat(right.length);

      expect(verifySignature(data(), garbage, KEY)).toBe(false);
      expect(() => verifySignature(data(), garbage, KEY)).not.toThrow();
    });
  });
});

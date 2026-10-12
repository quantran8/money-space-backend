import { randomBytes } from 'node:crypto';
import { identifierHmac, normalizeAccountNumber } from './identifier-hmac';
import {
  bearerFrom,
  generateIngestToken,
  hashIngestToken,
  isIngestTokenShape,
} from './ingest-token';
import { decryptPayload, encryptPayload } from './payload-cipher';
import { parseVndAmount } from './vnd-amount';

describe('parseVndAmount', () => {
  it.each([
    ['2,190,538', 2190538],
    ['2.000', 2000],
    ['500', 500],
    ['2,000.50', null],
    ['12,34', null],
    ['1,000.000', null],
    ['abc', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseVndAmount(raw)).toBe(expected);
  });
});

describe('ingest token', () => {
  it('generates a well-formed token whose hash matches', () => {
    const { token, hash, prefix } = generateIngestToken();
    expect(isIngestTokenShape(token)).toBe(true);
    expect(hashIngestToken(token)).toBe(hash);
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length / 2);
  });

  it('reads only a Bearer header', () => {
    expect(bearerFrom('Bearer abc')).toBe('abc');
    expect(bearerFrom('Basic abc')).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
  });
});

describe('identifier HMAC', () => {
  const key = randomBytes(32);

  it('is stable for the same account and differs per provider', () => {
    const a = identifierHmac(key, 'VCB', '0123456789');
    expect(identifierHmac(key, 'VCB', '0123456789')).toBe(a);
    expect(identifierHmac(key, 'TECHCOMBANK', '0123456789')).not.toBe(a);
  });

  it('normalizes separators and rejects masked numbers', () => {
    expect(normalizeAccountNumber('1903 1234-5678')).toBe('190312345678');
    expect(normalizeAccountNumber('1903xxxx5678')).toBeNull();
    expect(normalizeAccountNumber('1234')).toBeNull();
  });
});

describe('payload cipher', () => {
  it('round-trips and refuses the wrong key', () => {
    const key = randomBytes(32);
    const blob = encryptPayload(key, 'Số dư TK VCB');
    expect(decryptPayload(key, blob)).toBe('Số dư TK VCB');
    expect(() => decryptPayload(randomBytes(32), blob)).toThrow();
  });
});

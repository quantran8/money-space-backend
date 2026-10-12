import { createHash, randomBytes } from 'node:crypto';

export const INGEST_TOKEN_PREFIX = 'msk_live_';
const TOKEN_SHAPE = /^msk_live_[A-Za-z0-9_-]{43}$/;

/** 256-bit random token; only its hash is stored. */
export function generateIngestToken(): {
  token: string;
  hash: string;
  prefix: string;
} {
  const token = INGEST_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashIngestToken(token),
    prefix: token.slice(0, INGEST_TOKEN_PREFIX.length + 4),
  };
}

// A unique-index lookup on the hash; the token's entropy makes a plain sha256 enough.
export function hashIngestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isIngestTokenShape(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

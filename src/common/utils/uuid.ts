import { randomFillSync } from 'crypto';

/**
 * Generate a UUID v7 (RFC 9562): a 48-bit Unix-millisecond timestamp prefix
 * followed by version/variant bits and 74 random bits. v7 ids are
 * time-ordered, so they cluster newer rows together and make far better
 * B-tree primary keys than random v4 ids (which scatter inserts across the
 * whole index).
 *
 * Node's `crypto.randomUUID()` only mints v4, so we build v7 by hand rather
 * than pulling in a dependency.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  // Bytes 0-5: 48-bit big-endian millisecond timestamp.
  const now = Date.now();
  bytes[0] = (now / 0x10000000000) & 0xff;
  bytes[1] = (now / 0x100000000) & 0xff;
  bytes[2] = (now / 0x1000000) & 0xff;
  bytes[3] = (now / 0x10000) & 0xff;
  bytes[4] = (now / 0x100) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6; variant (10xx) in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }

  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

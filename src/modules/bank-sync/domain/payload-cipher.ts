import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; output is iv | tag | ciphertext. */
export function encryptPayload(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Throws when the key is wrong or the blob was tampered with. */
export function decryptPayload(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    'utf8',
  );
}

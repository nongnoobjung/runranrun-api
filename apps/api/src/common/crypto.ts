import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM. Layout: 12-byte IV | 16-byte tag | ciphertext. */
export function encryptPii(plain: string, keyBase64: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptPii(blob: Buffer, keyBase64: string): string {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

/** Normalises an ID card / passport number so "1-1037-00000-12-3" and "1103700000123" hash the same. */
export function normaliseIdDoc(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** Keyed hash used for the "one person per race" uniqueness check. */
export function hashIdDoc(value: string, hashKey: string): string {
  return createHmac('sha256', hashKey).update(normaliseIdDoc(value)).digest('hex');
}

export function sha256Hex(value: string, key = ''): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** Constant-time comparison of two secrets (signatures, shared keys). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

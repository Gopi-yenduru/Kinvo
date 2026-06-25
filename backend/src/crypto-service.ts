/**
 * Application-level field encryption for PHI (defense-in-depth on top of disk encryption).
 *
 * AES-256-GCM. The key is derived (SHA-256) from ENCRYPTION_KEY so any sufficiently
 * strong secret works. Stored format:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Backward/forward compatible:
 *  - If ENCRYPTION_KEY is NOT set, values pass through as plaintext (dev convenience).
 *  - decryptField() returns non-`enc:` values unchanged, so existing plaintext rows
 *    (written before encryption was enabled) still read correctly.
 *
 * NOTE: encrypted columns must not be used in SQL WHERE/LIKE/ORDER — only free-text
 * PHI that the app reads back whole is encrypted here.
 */
import crypto from 'crypto';

const PREFIX = 'enc:v1:';
const RAW = process.env.ENCRYPTION_KEY || '';
const KEY: Buffer | null = RAW ? crypto.createHash('sha256').update(RAW).digest() : null;

export const encryptionEnabled = !!KEY;

export function encryptField(value: string | null | undefined): string | null | undefined {
  if (!KEY || value == null || value === '') return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

export function decryptField<T extends string | null | undefined>(value: T): T {
  if (value == null || typeof value !== 'string' || !value.startsWith(PREFIX) || !KEY) return value;
  try {
    const [ivB, tagB, ctB] = value.slice(PREFIX.length).split(':');
    const iv = Buffer.from(ivB, 'base64');
    const tag = Buffer.from(tagB, 'base64');
    const ct = Buffer.from(ctB, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return (Buffer.concat([d.update(ct), d.final()]).toString('utf8')) as T;
  } catch {
    return value; // tampered / wrong key — return as-is rather than crash
  }
}

/**
 * Deterministic, keyed hash of a matchable identifier (e.g. a phone number) so it can be
 * stored and queried in WHERE/= (unlike encryptField, which is randomized per call). Phone
 * digits are normalized so "+91 98765-43210" and "9876543210" match; a non-numeric clinic
 * ID falls back to its lowercased form. Returns null for empty input.
 */
export function hashIdentifier(value: string | null | undefined): string | null {
  const raw = (value ?? '').toString().trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const norm = digits.length >= 4 ? digits : raw.toLowerCase().replace(/\s+/g, '');
  return crypto.createHmac('sha256', KEY || Buffer.from('id-hash-fallback')).update(norm).digest('hex');
}

/** Decrypt a single named field across an array of rows (mutates + returns the rows). */
export function decryptRows<T>(rows: T[], field: string): T[] {
  if (!KEY || !rows) return rows;
  for (const r of rows) {
    const v: any = (r as any)[field];
    if (typeof v === 'string') (r as any)[field] = decryptField(v);
  }
  return rows;
}

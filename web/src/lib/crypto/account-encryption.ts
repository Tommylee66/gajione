import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Bank account numbers, encrypted at rest.
 *
 * The key lives in the application environment and never in Postgres, so a
 * dump of the database alone does not yield anyone's account details. That
 * matters more here than in most places: an account number plus a name is
 * enough to attempt a transfer, and under UU PDP art. 4 it is specific
 * personal data.
 *
 * Must be a base64 string decoding to exactly 32 bytes (AES-256). The same key
 * has to be configured wherever payroll runs, or previously stored accounts
 * become unreadable — which surfaces as a payment file that cannot be built.
 */
function getKey(): Buffer {
  const key = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!key) throw new Error('ACCOUNT_ENCRYPTION_KEY is not configured');
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error('ACCOUNT_ENCRYPTION_KEY must be a base64 string decoding to 32 bytes');
  }
  return buf;
}

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function encryptAccount(plaintext: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptAccount(payload: EncryptedPayload): string {
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function last4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}

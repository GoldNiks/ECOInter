import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

function keyFromEnvironment(): Buffer | null {
  const secret = process.env.ECOINTER_MASTER_KEY;
  if (!secret) return null;
  return scryptSync(secret, 'ecointer-local-secret-v1', 32);
}

export function encryptSecret(plainText: string): string | null {
  const key = keyFromEnvironment();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const key = keyFromEnvironment();
  if (!key) throw new Error('ECOINTER_MASTER_KEY is not configured');
  const [version, iv, tag, body] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unsupported encrypted secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export function canEncryptSecrets(): boolean { return keyFromEnvironment() !== null; }

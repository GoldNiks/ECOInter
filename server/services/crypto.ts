import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function keyFromEnvironment(): Buffer | null {
  const secret = process.env.ECOINTER_MASTER_KEY?.trim();
  if (secret) return scryptSync(secret, 'ecointer-local-secret-v1', 32);

  // First-run convenience: generate a private local key automatically.
  // The key is stored in the local data directory, never in source control.
  const keyPath = process.env.ECOINTER_KEY_FILE ?? './data/master.key';
  try {
    fs.mkdirSync(path.dirname(path.resolve(keyPath)), { recursive: true });
    try {
      const existing = fs.readFileSync(keyPath);
      return existing.length === 32 ? existing : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const generated = randomBytes(32);
    try {
      fs.writeFileSync(keyPath, generated, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (error) {
      // Another local process may have won the first-run creation race.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const existing = fs.readFileSync(keyPath);
      return existing.length === 32 ? existing : null;
    }
  } catch {
    return null;
  }
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
  if (!key) throw new Error('Не удалось открыть локальный ключ ECOInter. Проверьте файл data/master.key.');
  const [version, iv, tag, body] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Неподдерживаемый формат зашифрованного токена.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export function canEncryptSecrets(): boolean { return keyFromEnvironment() !== null; }

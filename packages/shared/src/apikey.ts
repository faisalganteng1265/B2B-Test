import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from './hmac';

/** API keys: "mpk_<prefix>_<secret>". Stored as sha256(salt || key); the prefix allows O(1) lookup. */
export function generateApiKey(): { key: string; prefix: string; salt: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const key = `mpk_${prefix}_${randomBytes(24).toString('base64url')}`;
  const salt = randomBytes(16).toString('hex');
  return { key, prefix, salt, hash: hashApiKey(key, salt) };
}

export function hashApiKey(key: string, salt: string): string {
  return createHash('sha256').update(salt).update(key).digest('hex');
}

export function apiKeyPrefix(key: string): string | null {
  const m = /^mpk_([0-9a-f]{8})_[A-Za-z0-9_-]+$/.exec(key);
  return m ? m[1]! : null;
}

export function verifyApiKey(key: string, salt: string, hash: string): boolean {
  return safeEqual(hashApiKey(key, salt), hash);
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mobee-style request signature:
 * Base64(HMAC-SHA256(secret, METHOD\nPATH\nTIMESTAMP[\nBODY]))  (body only for POST/PUT)
 */
export function mobeeCanonical(method: string, path: string, timestamp: string, body?: string): string {
  const m = method.toUpperCase();
  const base = `${m}\n${path}\n${timestamp}`;
  return m === 'POST' || m === 'PUT' ? `${base}\n${body ?? ''}` : base;
}

export function signMobee(secret: string, method: string, path: string, timestamp: string, body?: string): string {
  return createHmac('sha256', secret).update(mobeeCanonical(method, path, timestamp, body)).digest('base64');
}

export const MOBEE_TIMESTAMP_TOLERANCE_S = 30;

export type MobeeVerifyResult = { ok: true } | { ok: false; code: 'INVALID_SIGNATURE' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'MISSING_HEADERS' };

export function verifyMobee(args: {
  secret: string;
  method: string;
  path: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body?: string;
  nowS?: number;
}): MobeeVerifyResult {
  const { timestamp, signature } = args;
  if (!timestamp || !signature) return { ok: false, code: 'MISSING_HEADERS' };
  const ts = Number(timestamp);
  const now = args.nowS ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MOBEE_TIMESTAMP_TOLERANCE_S) {
    return { ok: false, code: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }
  const expected = signMobee(args.secret, args.method, args.path, timestamp, args.body);
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, code: 'INVALID_SIGNATURE' };
}

/** hex HMAC-SHA256 of a raw body (BI-FAST webhook X-Signature). */
export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyHmacHex(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  return safeEqual(hmacHex(secret, body), signature);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

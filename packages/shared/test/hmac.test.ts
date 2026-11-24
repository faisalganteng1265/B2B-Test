import { describe, expect, it } from 'vitest';
import { hmacHex, signMobee, verifyHmacHex, verifyMobee, mobeeCanonical } from '../src/hmac';
import { classifyHttp, classifyError, UpstreamError } from '../src/errors';

describe('mobee hmac', () => {
  const secret = 'top-secret-key';
  it('builds canonical string with body only for POST/PUT', () => {
    expect(mobeeCanonical('get', '/v1/balances', '100')).toBe('GET\n/v1/balances\n100');
    expect(mobeeCanonical('POST', '/v1/x', '100', '{"a":1}')).toBe('POST\n/v1/x\n100\n{"a":1}');
  });
  it('verifies a valid signature', () => {
    const ts = '1700000000';
    const sig = signMobee(secret, 'POST', '/v1/quick-swap/lock', ts, '{"amount":"1"}');
    expect(
      verifyMobee({
        secret,
        method: 'POST',
        path: '/v1/quick-swap/lock',
        timestamp: ts,
        signature: sig,
        body: '{"amount":"1"}',
        nowS: 1700000010,
      }),
    ).toEqual({ ok: true });
  });
  it('rejects tampered body, wrong secret and stale timestamp', () => {
    const ts = '1700000000';
    const sig = signMobee(secret, 'POST', '/p', ts, 'a');
    expect(
      verifyMobee({
        secret,
        method: 'POST',
        path: '/p',
        timestamp: ts,
        signature: sig,
        body: 'b',
        nowS: 1700000000,
      }),
    ).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
    expect(
      verifyMobee({
        secret: 'other',
        method: 'POST',
        path: '/p',
        timestamp: ts,
        signature: sig,
        body: 'a',
        nowS: 1700000000,
      }).ok,
    ).toBe(false);
    expect(
      verifyMobee({
        secret,
        method: 'POST',
        path: '/p',
        timestamp: ts,
        signature: sig,
        body: 'a',
        nowS: 1700000031,
      }),
    ).toEqual({ ok: false, code: 'TIMESTAMP_OUT_OF_TOLERANCE' });
    expect(
      verifyMobee({ secret, method: 'POST', path: '/p', timestamp: undefined, signature: sig, nowS: 1 }),
    ).toEqual({ ok: false, code: 'MISSING_HEADERS' });
  });
  it('verifies hex webhook signature', () => {
    const body = '{"transferId":"t1"}';
    expect(verifyHmacHex('s', body, hmacHex('s', body))).toBe(true);
    expect(verifyHmacHex('s', body + ' ', hmacHex('s', body))).toBe(false);
    expect(verifyHmacHex('s', body, undefined)).toBe(false);
  });
});

describe('error classification', () => {
  it('classifies http statuses', () => {
    expect(classifyHttp(500)).toBe('retryable');
    expect(classifyHttp(503)).toBe('retryable');
    expect(classifyHttp(429)).toBe('retryable');
    expect(classifyHttp(400)).toBe('terminal');
    expect(classifyHttp(409, 'QUOTE_EXPIRED')).toBe('terminal');
    expect(classifyHttp(503, 'PRICE_UNAVAILABLE')).toBe('retryable');
    expect(classifyHttp(422, 'PRICE_UNAVAILABLE')).toBe('retryable');
  });
  it('treats network errors as retryable', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('retryable');
    expect(classifyError(new UpstreamError('bad', 'terminal', 'VALIDATION'))).toBe('terminal');
  });
});

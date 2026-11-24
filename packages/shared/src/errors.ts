/**
 * Error classification shared by workflow and clients.
 * retryable: transient (5xx, timeout, network, 429, PRICE_UNAVAILABLE)
 * terminal:  will not succeed by retrying the same request (validation, QUOTE_EXPIRED, bank reject)
 */
export type ErrorClass = 'retryable' | 'terminal';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly cls: ErrorClass,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
  get retryable() {
    return this.cls === 'retryable';
  }
}

/** Error codes that are retryable even when returned with a 4xx status. */
const RETRYABLE_CODES = new Set([
  'PRICE_UNAVAILABLE',
  'RATE_LIMITED',
  'TIMESTAMP_OUT_OF_TOLERANCE',
  'NOT_READY',
]);

export function classifyHttp(status: number, code?: string): ErrorClass {
  if (code && RETRYABLE_CODES.has(code)) return 'retryable';
  if (status >= 500 || status === 408 || status === 429) return 'retryable';
  return 'terminal';
}

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof UpstreamError) return err.cls;
  if (err instanceof Error) {
    // fetch network failures / aborts / timeouts are transient
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'TypeError')
      return 'retryable';
    const code = (err as { code?: string }).code;
    if (code && /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(code)) return 'retryable';
  }
  return 'retryable';
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

import { classifyHttp, UpstreamError } from '../errors';

export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Perform a request; map every failure to an UpstreamError with a retryable/terminal class. */
export async function httpJson<T>(
  o: HttpOptions,
  method: string,
  pathWithQuery: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(`${o.baseUrl}${pathWithQuery}`, {
      method,
      body,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    const code = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    throw new UpstreamError(
      `${method} ${pathWithQuery}: ${e instanceof Error ? e.message : String(e)}`,
      'retryable',
      code,
    );
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-json body */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    const code = err?.code ?? `HTTP_${res.status}`;
    throw new UpstreamError(
      `${method} ${pathWithQuery} -> ${res.status} ${code}: ${err?.message ?? text.slice(0, 200)}`,
      classifyHttp(res.status, code),
      code,
      res.status,
      json,
    );
  }
  return json as T;
}

import { apiFetch } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** SSE passthrough: browser ⇄ Next (no token) ⇄ API /v1/stream (admin token). */
export async function GET(req: Request) {
  try {
    const upstream = await apiFetch('/v1/stream', {
      signal: req.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!upstream.ok || !upstream.body) return new Response('upstream unavailable', { status: 502 });
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch {
    return new Response('upstream unavailable', { status: 502 });
  }
}

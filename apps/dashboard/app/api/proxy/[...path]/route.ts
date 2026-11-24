import { apiFetch } from '@/lib/server';

// Only these API prefixes are reachable from the browser.
const ALLOWED = /^(admin\/|v1\/quotes\/)/;

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const p = path.join('/');
  if (!ALLOWED.test(p))
    return Response.json({ error: { code: 'FORBIDDEN', message: 'path not proxied' } }, { status: 403 });
  const url = new URL(req.url);
  try {
    const res = await apiFetch(`/${p}${url.search}`, {
      method: req.method,
      body: req.method === 'GET' ? undefined : await req.text(),
      headers: { 'content-type': 'application/json' },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch (e) {
    return Response.json(
      { error: { code: 'API_UNREACHABLE', message: e instanceof Error ? e.message : String(e) } },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const dynamic = 'force-dynamic';

import 'server-only';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

/** Server-side call to the Mopay API with the admin token (never sent to the browser). */
export function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-admin-token', ADMIN_TOKEN);
  return fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' });
}

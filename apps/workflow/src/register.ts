/** Register (or re-register) the workflow deployment with the Restate admin API. */
export async function registerDeployment(adminUrl: string, uri: string, attempts = 30): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${adminUrl}/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri, force: true }),
      });
      const body = await res.text();
      if (res.ok) return JSON.parse(body);
      last = new Error(`register ${res.status}: ${body.slice(0, 300)}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw last;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = process.env.RESTATE_ADMIN_URL ?? 'http://localhost:9070';
  const uri = process.argv[2] ?? process.env.WORKFLOW_PUBLIC_URL ?? 'http://localhost:9080';
  const r = (await registerDeployment(admin, uri)) as { services?: { name: string }[] };
  console.log(`registered ${uri}: ${r.services?.map((s) => s.name).join(', ')}`);
}

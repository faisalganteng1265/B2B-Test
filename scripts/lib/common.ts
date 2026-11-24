import { parseArgs } from 'node:util';
import { asc, eq, and } from 'drizzle-orm';
import { CHAINS, envFields, loadDeployment, loadEnv } from '@mopay/config';
import { clients, createDb, depositAddresses } from '@mopay/db';
import { z } from 'zod';

export const env = loadEnv({
  CHAIN: envFields.CHAIN,
  RPC_URLS: envFields.RPC_URLS,
  DATABASE_URL: envFields.DATABASE_URL,
  API_URL: envFields.API_URL,
  ADMIN_TOKEN: envFields.ADMIN_TOKEN,
  MOBEE_URL: envFields.MOBEE_URL,
  BIFAST_URL: envFields.BIFAST_URL,
  CLIENT_A_PRIVATE_KEY: z.string().optional(),
  CLIENT_B_PRIVATE_KEY: z.string().optional(),
});
export const chain = CHAINS[env.CHAIN];

export const args = (opts: NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>['options']>) =>
  parseArgs({ options: opts, allowPositionals: true }).values;

/** Clients in seed order: A = first, B = second (matches CLIENT_A/B_PRIVATE_KEY). */
export async function demoClients() {
  const h = createDb(env.DATABASE_URL, { max: 2, appName: 'scripts' });
  const rows = await h.db
    .select({ id: clients.id, name: clients.name, address: depositAddresses.address })
    .from(clients)
    .innerJoin(
      depositAddresses,
      and(eq(depositAddresses.clientId, clients.id), eq(depositAddresses.chainId, chain.chainId)),
    )
    .orderBy(asc(clients.createdAt));
  await h.close();
  const keys = [env.CLIENT_A_PRIVATE_KEY, env.CLIENT_B_PRIVATE_KEY];
  return rows.slice(0, 2).map((r, i) => ({ ...r, letter: 'AB'[i]!, privateKey: keys[i] }));
}

export const token = () => loadDeployment(chain.chainId).tokens.USDT!;

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { CHAINS, envFields, loadEnv, repoRoot } from '@mopay/config';
import { generateApiKey } from '@mopay/shared';
import { createDb, type Db } from './client';
import { clientBankAccounts, clients, depositAddresses } from './schema';

export interface SeedClient {
  name: string;
  subaccount: string;
  bank: { bankCode: string; accountNumber: string; accountName: string };
}

export const SEED_CLIENTS: SeedClient[] = [
  { name: 'PT Nusantara Digital Niaga', subaccount: 'sub-nusantara', bank: { bankCode: '014', accountNumber: '8830112233', accountName: 'PT NUSANTARA DIGITAL NIAGA' } },
  { name: 'PT Garuda Logistik Ekspres', subaccount: 'sub-garuda', bank: { bankCode: '008', accountNumber: '1230009988', accountName: 'PT GARUDA LOGISTIK EKSPRES' } },
];

export type AddressProvider = (subaccount: string) => Promise<string>;

/** Idempotent: existing clients (by subaccount) are left untouched. Returns plaintext keys of newly created clients. */
export async function seed(db: Db, chainId: number, addressFor: AddressProvider) {
  const created: { name: string; apiKey: string; clientId: string; depositAddress: string }[] = [];
  for (const c of SEED_CLIENTS) {
    const existing = await db.query.clients.findFirst({ where: eq(clients.exchangeSubaccount, c.subaccount) });
    if (existing) continue;
    const k = generateApiKey();
    const address = (await addressFor(c.subaccount)).toLowerCase();
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(clients)
        .values({ name: c.name, apiKeyHash: k.hash, apiKeySalt: k.salt, apiKeyPrefix: k.prefix, exchangeSubaccount: c.subaccount })
        .returning();
      await tx.insert(clientBankAccounts).values({ clientId: row!.id, ...c.bank, verifiedAt: new Date() });
      await tx.insert(depositAddresses).values({ clientId: row!.id, chainId, address, source: 'mobee' });
      created.push({ name: c.name, apiKey: k.key, clientId: row!.id, depositAddress: address });
    });
  }
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv({ DATABASE_URL: envFields.DATABASE_URL, CHAIN: envFields.CHAIN, MOBEE_URL: envFields.MOBEE_URL });
  const chainId = CHAINS[env.CHAIN].chainId;
  const h = createDb(env.DATABASE_URL, { max: 2, appName: 'seed' });
  const { mobeeAddressProvider } = await import('./seed-mobee');
  const created = await seed(h.db, chainId, await mobeeAddressProvider(env.MOBEE_URL, chainId));
  // Plaintext keys are written only to the gitignored data/ dir, merged with earlier runs.
  const dir = join(repoRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'seed-clients.json');
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as typeof created) : [];
  writeFileSync(file, JSON.stringify([...prev, ...created], null, 2), { mode: 0o600 });
  console.log(created.length ? `seeded ${created.length} clients -> data/seed-clients.json` : 'already seeded');
  await h.close();
}

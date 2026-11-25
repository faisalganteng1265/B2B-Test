import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { CHAINS, envFields, loadEnv, repoRoot } from '@mopay/config';
import { z } from 'zod';
import { BANK_DIRECTORY, generateApiKey, IndodaxClient } from '@mopay/shared';
import { createDb, type Db } from './client';
import { clientBankAccounts, clients, clientWallets, depositAddresses } from './schema';

export interface SeedClient {
  name: string;
  subaccount: string;
  bank: { bankCode: string; accountNumber: string; accountName: string };
}

const bank = (accountNumber: string) => {
  const e = BANK_DIRECTORY.find((b) => b.accountNumber === accountNumber)!;
  return { bankCode: e.bankCode, accountNumber: e.accountNumber, accountName: e.accountName };
};

export const SEED_CLIENTS: SeedClient[] = [
  { name: 'PT Nusantara Digital Niaga', subaccount: 'sub-nusantara', bank: bank('8830112233') },
  { name: 'PT Garuda Logistik Ekspres', subaccount: 'sub-garuda', bank: bank('1230009988') },
];

export type AddressProvider = (subaccount: string) => Promise<string>;

/** Idempotent: existing clients (by subaccount) are left untouched. Returns plaintext keys of newly created clients. */
export async function seed(db: Db, chainId: number, addressFor: AddressProvider) {
  const created: { name: string; apiKey: string; clientId: string; depositAddress: string }[] = [];
  for (const c of SEED_CLIENTS) {
    const existing = await db.query.clients.findFirst({
      where: eq(clients.exchangeSubaccount, c.subaccount),
    });
    if (existing) continue;
    const k = generateApiKey();
    const address = (await addressFor(c.subaccount)).toLowerCase();
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(clients)
        .values({
          name: c.name,
          apiKeyHash: k.hash,
          apiKeySalt: k.salt,
          apiKeyPrefix: k.prefix,
          exchangeSubaccount: c.subaccount,
        })
        .returning();
      await tx.insert(clientBankAccounts).values({ clientId: row!.id, ...c.bank, verifiedAt: new Date() });
      await tx.insert(depositAddresses).values({ clientId: row!.id, chainId, address, source: 'mobee' });
      created.push({ name: c.name, apiKey: k.key, clientId: row!.id, depositAddress: address });
    });
  }
  return created;
}

/**
 * Indodax model: ONE shared deposit address (Mopay's exchange account) and, per client, the wallets
 * it registered (KYB) as senders. Idempotent: re-running only adds what is missing.
 */
export async function seedIndodax(db: Db, chainId: number, sharedAddress: string, wallets: string[]) {
  const created: { name: string; apiKey: string; clientId: string; wallet: string | null }[] = [];
  await db
    .insert(depositAddresses)
    .values({
      clientId: null,
      chainId,
      address: sharedAddress.toLowerCase(),
      source: 'indodax',
      kind: 'shared',
    })
    .onConflictDoNothing();
  for (const [i, c] of SEED_CLIENTS.entries()) {
    let row = await db.query.clients.findFirst({ where: eq(clients.exchangeSubaccount, c.subaccount) });
    if (!row) {
      const k = generateApiKey();
      row = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(clients)
          .values({
            name: c.name,
            apiKeyHash: k.hash,
            apiKeySalt: k.salt,
            apiKeyPrefix: k.prefix,
            exchangeSubaccount: c.subaccount,
          })
          .returning();
        await tx.insert(clientBankAccounts).values({ clientId: r!.id, ...c.bank, verifiedAt: new Date() });
        return r!;
      });
      created.push({ name: c.name, apiKey: k.key, clientId: row.id, wallet: wallets[i] ?? null });
    }
    const w = wallets[i];
    if (w) {
      await db
        .insert(clientWallets)
        .values({
          clientId: row.id,
          chainId,
          address: w.toLowerCase(),
          label: 'treasury wallet (KYB)',
          verifiedAt: new Date(),
        })
        .onConflictDoNothing();
    }
  }
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv({
    DATABASE_URL: envFields.DATABASE_URL,
    CHAIN: envFields.CHAIN,
    INDODAX_URL: envFields.INDODAX_URL,
    INDODAX_API_KEY: envFields.INDODAX_API_KEY,
    INDODAX_API_SECRET: envFields.INDODAX_API_SECRET,
    CLIENT_WALLETS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
  });
  const chainId = CHAINS[env.CHAIN].chainId;
  const h = createDb(env.DATABASE_URL, { max: 2, appName: 'seed' });
  // The deposit address is issued by the exchange: GET /api/v2/capital/deposit/address/list
  const indodax = new IndodaxClient({
    baseUrl: env.INDODAX_URL,
    apiKey: env.INDODAX_API_KEY,
    apiSecret: env.INDODAX_API_SECRET,
  });
  const [addr] = await indodax.depositAddresses('USDT', 'base');
  if (!addr?.address) throw new Error('exchange returned no USDT deposit address');
  const created = await seedIndodax(h.db, chainId, addr.address, env.CLIENT_WALLETS);
  console.log(`exchange deposit address (shared): ${addr.address}`);
  // Plaintext keys are written only to the gitignored data/ dir, merged with earlier runs.
  const dir = join(repoRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'seed-clients.json');
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as typeof created) : [];
  writeFileSync(file, JSON.stringify([...prev, ...created], null, 2), { mode: 0o600 });
  console.log(
    created.length ? `seeded ${created.length} clients -> data/seed-clients.json` : 'already seeded',
  );
  await h.close();
}

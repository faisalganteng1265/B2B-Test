import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { erc20Abi, getAbiItem, type Address } from 'viem';
import { CHAINS, envFields, loadDeployment, loadEnv, repoRoot } from '@mopay/config';
import { Chaos, createChainClient, createLogger, PriceFeed } from '@mopay/shared';
import { createIndodaxMock } from './app';
import { IndodaxStore } from './store';

const env = loadEnv({
  CHAIN: envFields.CHAIN,
  RPC_URLS: envFields.RPC_URLS,
  ADMIN_TOKEN: envFields.ADMIN_TOKEN,
  LOG_LEVEL: envFields.LOG_LEVEL,
  INDODAX_API_KEY: envFields.INDODAX_API_KEY,
  INDODAX_API_SECRET: envFields.INDODAX_API_SECRET,
  MOPAY_BANK_CODE: envFields.MOPAY_BANK_CODE,
  MOPAY_BANK_ACCOUNT: envFields.MOPAY_BANK_ACCOUNT,
  MOPAY_BANK_NAME: envFields.MOPAY_BANK_NAME,
  PORT: z.coerce.number().default(4100),
  INDODAX_DB_PATH: z.string().default(join(repoRoot(), 'data', 'indodax.sqlite')),
  PRICE_SOURCE: z.enum(['indodax', 'fixed']).default('indodax'),
  PRICE_FIXED_RATE: z.string().default('16500'),
  INDODAX_MIN_CONFIRM: z.coerce.number().int().default(5),
  INDODAX_CREDIT_DELAY_MS_MIN: z.coerce.number().int().default(1000),
  INDODAX_CREDIT_DELAY_MS_MAX: z.coerce.number().int().default(5000),
  INDODAX_COMMISSION_BPS: z.coerce.bigint().default(41n),
  INDODAX_ORDER_VISIBILITY_DELAY_MS: z.coerce.number().int().default(1500),
  INDODAX_FIAT_WITHDRAW_FEE_IDR: z.coerce.bigint().default(10_000n),
  INDODAX_FIAT_SETTLE_MS: z.coerce.number().int().default(10_000),
  INDODAX_SCAN_MS: z.coerce.number().int().default(1500),
});

const log = createLogger('indodax-mock', env.LOG_LEVEL);
const chain = CHAINS[env.CHAIN];
const deployment = loadDeployment(chain.chainId);
const client = createChainClient(chain.chainId, env.RPC_URLS);
const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' });
const chaos = Chaos.fromEnv();
const store = new IndodaxStore(env.INDODAX_DB_PATH);

const mock = createIndodaxMock({
  store,
  priceFeed: new PriceFeed({ source: env.PRICE_SOURCE, fixedRate: env.PRICE_FIXED_RATE }),
  chaos,
  apiKey: env.INDODAX_API_KEY,
  apiSecret: env.INDODAX_API_SECRET,
  adminToken: env.ADMIN_TOKEN,
  tokens: Object.fromEntries(Object.entries(deployment.tokens).map(([sym, a]) => [a.toLowerCase(), sym])),
  tokenDecimals: 6,
  network: 'base',
  scanner: {
    head: async () => Number(await client.getBlockNumber({ cacheTime: 0 })),
    logs: async (from, to, address, tokens) => {
      const logs = await client.getLogs({
        address: tokens as Address[],
        event: transferEvent,
        args: { to: address as Address },
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
        strict: true,
      });
      return logs.map((l) => ({
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        blockNumber: Number(l.blockNumber),
        from: l.args.from,
        to: l.args.to,
        token: l.address,
        value: l.args.value,
      }));
    },
  },
  // Start scanning a little behind the head the first time (the address is new).
  scanStartBlock: Number(store.meta('scan_last_block') ?? (await client.getBlockNumber())) - 50,
  minConfirm: env.INDODAX_MIN_CONFIRM,
  creditDelayMs: [env.INDODAX_CREDIT_DELAY_MS_MIN, env.INDODAX_CREDIT_DELAY_MS_MAX],
  commissionBps: env.INDODAX_COMMISSION_BPS,
  orderVisibilityDelayMs: env.INDODAX_ORDER_VISIBILITY_DELAY_MS,
  kycBank: {
    bankCode: env.MOPAY_BANK_CODE,
    accountNumber: env.MOPAY_BANK_ACCOUNT,
    accountName: env.MOPAY_BANK_NAME,
  },
  fiatWithdrawFeeIdr: env.INDODAX_FIAT_WITHDRAW_FEE_IDR,
  fiatSettleMs: env.INDODAX_FIAT_SETTLE_MS,
  log,
});

let failures = 0;
const timer = setInterval(() => {
  mock.scanOnce().then(
    () => (failures = 0),
    (err) => failures++ < 3 && log.warn({ err: String(err) }, 'deposit scan failed (will retry)'),
  );
}, env.INDODAX_SCAN_MS);

const server = serve({ fetch: mock.app.fetch, port: env.PORT }, (i) =>
  log.info(
    { port: i.port, depositAddress: mock.depositAddress('USDT'), chaos: chaos.config },
    'indodax-mock (TAPIv2) listening',
  ),
);
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });

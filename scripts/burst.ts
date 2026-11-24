/** Burst N real deposits, alternating clients A/B, random amounts (10–1000 mUSDT).
 *  tsx scripts/burst.ts --count 50 */
import { sendTokenTransfers } from '@mopay/shared';
import { args, c, chain, demoClients, env, token } from './lib/common';

const a = args({ count: { type: 'string', default: '20' } });
const n = Number(a.count);
const cls = (await demoClients()).filter((x) => x.privateKey);
if (!cls.length) throw new Error('no demo clients with private keys (run make seed, check .env)');
const t0 = Date.now();
const all = await Promise.all(
  cls.map((cl, i) => {
    const k = Math.floor(n / cls.length) + (i < n % cls.length ? 1 : 0);
    const amounts = Array.from({ length: k }, () =>
      BigInt(10_000_000 + Math.floor(Math.random() * 990_000_000)),
    );
    return sendTokenTransfers({
      chainId: chain.chainId,
      rpcUrls: env.RPC_URLS,
      token: token(),
      privateKey: cl.privateKey!,
      to: cl.address,
      amounts,
    }).then((r) => ({ cl, r }));
  }),
);
for (const { cl, r } of all)
  console.log(
    `${c.green(String(r.hashes.length).padStart(3))} deposits  ${cl.name}  ${c.dim(r.hashes[0] ?? '')}…`,
  );
console.log(c.bold(`broadcast ${n} deposits in ${((Date.now() - t0) / 1000).toFixed(1)}s`));

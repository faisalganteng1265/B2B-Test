/** Send a real mUSDT deposit on Base Sepolia from a client test wallet to its deposit address.
 *  tsx scripts/send-deposit.ts --client A --amount 1000 */
import { parseToken, sendTokenTransfers } from '@mopay/shared';
import { args, c, chain, demoClients, env, token } from './lib/common';

const a = args({
  client: { type: 'string', default: 'A' },
  amount: { type: 'string', default: '100' },
  wait: { type: 'boolean', default: false },
});
const cl = (await demoClients()).find((x) => x.letter === String(a.client).toUpperCase());
if (!cl?.privateKey)
  throw new Error(`client ${a.client} not found or CLIENT_${a.client}_PRIVATE_KEY missing (run make seed)`);
const r = await sendTokenTransfers({
  chainId: chain.chainId,
  rpcUrls: env.RPC_URLS,
  token: token(),
  privateKey: cl.privateKey,
  to: cl.address,
  amounts: [parseToken(String(a.amount))],
  waitForReceipts: Boolean(a.wait),
});
console.log(`${c.green('sent')} ${a.amount} mUSDT  ${cl.name} → ${cl.address}`);
console.log(`  ${chain.explorerTxUrl(r.hashes[0]!)}`);

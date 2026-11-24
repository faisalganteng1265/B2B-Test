import { createWalletClient, erc20Abi, fallback, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createChainClient } from './chain';

/**
 * Demo helper: send real mock-token transfers (Base Sepolia) from a client test wallet to its
 * deposit address. Nonces are assigned explicitly so a burst of N transfers never collides.
 * Never used for anything but the testnet demo.
 */
export async function sendTokenTransfers(opts: {
  chainId: number;
  rpcUrls: string[];
  token: string;
  privateKey: string;
  to: string;
  amounts: bigint[];
  waitForReceipts?: boolean;
}): Promise<{ hashes: Hex[]; from: string }> {
  if (opts.chainId === 8453) throw new Error('refusing to send demo transfers on Base mainnet');
  const chain = opts.chainId === 84532 ? baseSepolia : base;
  const account = privateKeyToAccount(opts.privateKey as Hex);
  const pub = createChainClient(opts.chainId, opts.rpcUrls);
  const wallet = createWalletClient({ account, chain, transport: fallback(opts.rpcUrls.map((u) => http(u))) });
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const hashes: Hex[] = [];
  for (const amount of opts.amounts) {
    const hash = await wallet.writeContract({
      address: opts.token as Hex,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [opts.to as Hex, amount],
      nonce: nonce++,
      chain,
    });
    hashes.push(hash);
  }
  if (opts.waitForReceipts) await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  return { hashes, from: account.address };
}

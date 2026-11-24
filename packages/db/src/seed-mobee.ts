import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { AddressProvider } from './seed';

/**
 * Deposit addresses are issued by the exchange (Mobee). Phase 2 placeholder: random address.
 * Replaced in phase 3 by a call to mobee-mock POST /v1/wallet-addresses.
 */
export async function mobeeAddressProvider(_mobeeUrl: string, _chainId: number): Promise<AddressProvider> {
  return async () => privateKeyToAccount(generatePrivateKey()).address;
}

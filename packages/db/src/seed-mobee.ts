import { envFields, loadEnv } from '@mopay/config';
import { MobeeClient } from '@mopay/shared';
import type { AddressProvider } from './seed';

/** Deposit addresses are issued by the exchange: ask mobee-mock (POST /v1/wallet-addresses). */
export async function mobeeAddressProvider(mobeeUrl: string, chainId: number): Promise<AddressProvider> {
  const env = loadEnv({
    MOBEE_API_KEY: envFields.MOBEE_API_KEY,
    MOBEE_API_SECRET: envFields.MOBEE_API_SECRET,
  });
  const client = new MobeeClient({
    baseUrl: mobeeUrl,
    apiKey: env.MOBEE_API_KEY,
    apiSecret: env.MOBEE_API_SECRET,
  });
  return async (subaccount) => (await client.createWalletAddress(subaccount, chainId)).address;
}

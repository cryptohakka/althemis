/**
 * protocol/arc.ts
 * Arc Canteen testnet — viem chain definition + clients
 * Chain config read from .env (ARC_RPC_URL, ARC_CHAIN_ID)
 */
import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type PublicClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── Chain definition ──────────────────────────────────────────
function getArcChain(): Chain {
  const rpc    = process.env.ARC_RPC_URL;
  const chainId = Number(process.env.ARC_CHAIN_ID);
  if (!rpc)     throw new Error('ARC_RPC_URL not set in .env');
  if (!chainId) throw new Error('ARC_CHAIN_ID not set in .env');

  return defineChain({
    id:   chainId,
    name: 'Arc Canteen Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    testnet: true,
  });
}

export const arcChain = getArcChain();

// ── Public client (read-only) ─────────────────────────────────
export function getPublicClient(): PublicClient {
  return createPublicClient({
    chain: arcChain,
    transport: http(process.env.ARC_RPC_URL!, { timeout: 30000, retryCount: 8, retryDelay: 2000 }),
  });
}

// ── Wallet client (signing) ───────────────────────────────────
export function getOracleClient() {
  const pk = process.env.ORACLE_PRIVATE_KEY;
  if (!pk) throw new Error('ORACLE_PRIVATE_KEY not set in .env');
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: arcChain,
    transport: http(process.env.ARC_RPC_URL!, { timeout: 30000, retryCount: 8, retryDelay: 2000 }),
  });
}

export function getOracleAddress(): `0x${string}` {
  const pk = process.env.ORACLE_PRIVATE_KEY;
  if (!pk) throw new Error('ORACLE_PRIVATE_KEY not set in .env');
  return privateKeyToAccount(pk as `0x${string}`).address;
}

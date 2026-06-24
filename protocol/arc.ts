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
    transport: http(process.env.ARC_RPC_URL!, { timeout: 8000, retryCount: 2, retryDelay: 1000 }),
  });
}

// ── Wallet client (signing) ───────────────────────────────────
// ── Wallet client factory ─────────────────────────────────────
/** 汎用 wallet factory — 任意の private key で account 束縛 client を生成 */
export function makeWalletClient(pk: `0x${string}`) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: arcChain,
    transport: http(process.env.ARC_RPC_URL!, { timeout: 8000, retryCount: 2, retryDelay: 1000 }),
  });
}

/** oracle は makeWalletClient の特殊ケース */
export function getOracleClient() {
  const pk = process.env.ORACLE_PRIVATE_KEY;
  if (!pk) throw new Error('ORACLE_PRIVATE_KEY not set in .env');
  return makeWalletClient(pk as `0x${string}`);
}

export function getOracleAddress(): `0x${string}` {
  const pk = process.env.ORACLE_PRIVATE_KEY;
  if (!pk) throw new Error('ORACLE_PRIVATE_KEY not set in .env');
  return privateKeyToAccount(pk as `0x${string}`).address;
}

// ── Roster: agent role → wallet ───────────────────────────────
export type RosterRole = 'PCHEAP' | 'PHONEST' | 'PLIAR' | 'CBUYER' | 'XCHAL';

export const ROSTER_ROLES: RosterRole[] = ['PCHEAP', 'PHONEST', 'PLIAR', 'CBUYER', 'XCHAL'];

export interface RosterAgent {
  role:    RosterRole;
  client:  ReturnType<typeof makeWalletClient>;
  address: `0x${string}`;
}

/** role の env から wallet client を生成 */
export function makeRosterAgent(role: RosterRole): RosterAgent {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  if (!pk) throw new Error(`${role}_PRIVATE_KEY not set in .env`);
  const client = makeWalletClient(pk as `0x${string}`);
  return { role, client, address: client.account!.address };
}

/** roster 全員を生成。起動時に1回呼んで使い回す(singleton 前提) */
export function loadRoster(): Record<RosterRole, RosterAgent> {
  const out = {} as Record<RosterRole, RosterAgent>;
  for (const role of ROSTER_ROLES) out[role] = makeRosterAgent(role);
  return out;
}

/**
 * protocol/escrow.ts
 * Typed viem wrapper for ERC8183 core + BondHook
 * Covers the job lifecycle Althemis needs:
 *   createJob / setBudget / fund / submit / complete / reject / getJob
 * Plus bond helpers: deposit / withdraw / freeBalance / setTier
 */
import 'dotenv/config';
import { parseAbi, encodeFunctionData, type Address, type Hex } from 'viem';
import { getPublicClient, getOracleClient, getOracleAddress } from './arc.js';

// ── Contract addresses (from .env) ────────────────────────────
export const ERC8183_ADDRESS  = process.env.ERC8183_ADDRESS  as Address;
export const BOND_HOOK_ADDRESS = process.env.BOND_HOOK_ADDRESS as Address;
export const USDC_ADDRESS     = process.env.USDC_ADDRESS     as Address;

// ── ERC8183 ABI (subset used by Althemis) ─────────────────────
export const ERC8183_ABI = parseAbi([
  // Core lifecycle
  'function createJob(address provider, address evaluator, uint48 expiredAt, string description, address hook, uint256 providerAgentId) returns (uint256)',
  'function setBudget(uint256 jobId, address token, uint256 amount, bytes optParams)',
  'function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)',
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes32 reason, bytes optParams)',
  'function reject(uint256 jobId, bytes32 reason, bytes optParams)',
  'function claimRefund(uint256 jobId)',
  // Read
  // getJob uses JSON ABI (see GET_JOB_ABI below)
  'function jobCounter() view returns (uint256)',
  // Events
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint48 expiredAt, address hook)',
  'event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)',
  'event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)',
  'event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)',
  'event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)',
]);

// ── BondHook ABI ─────────────────────────────────────────────
export const BOND_HOOK_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function freeBalance(address provider) view returns (uint256)',
  'function bondBalance(address provider) view returns (uint256)',
  'function bondLocked(address provider) view returns (uint256)',
  'function setProviderTier(address provider, uint8 tier)',
  'function providerTier(address provider) view returns (uint8)',
  'function providerJobCount(address provider) view returns (uint256)',
  'function getBondRate(address provider) view returns (uint256)',
  'function SLASH_REASON() view returns (bytes32)',
  'event BondDeposited(address indexed provider, uint256 amount)',
  'event BondSlashed(uint256 indexed jobId, address indexed provider, uint256 amount, address consumer, address treasury)',
  'event TierUpdated(address indexed provider, uint8 newTier)',
]);

// ── USDC ABI (approve + balanceOf) ───────────────────────────
const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

// ── JobStatus enum ────────────────────────────────────────────
export enum JobStatus {
  Open = 0, Funded = 1, Submitted = 2,
  Completed = 3, Rejected = 4, Expired = 5,
}

export enum ProviderTier { Bronze = 0, Silver = 1, Gold = 2 }

// ── Job type ──────────────────────────────────────────────────
export interface Job {
  jobId:        bigint;
  client:       Address;
  status:       JobStatus;
  provider:     Address;
  expiredAt:    number;
  evaluator:    Address;
  submittedAt:  number;
  budget:       bigint;
  hook:         Address;
  paymentToken: Address;
  description:  string;
}

// ── Read helpers ──────────────────────────────────────────────

export async function getJob(jobId: bigint): Promise<Job> {
  const pub = getPublicClient();
  const raw = await pub.readContract({
    address: ERC8183_ADDRESS,
    abi: GET_JOB_ABI,
    functionName: 'getJob',
    args: [jobId],
  }) as any;

  return {
    jobId,
    client:       raw.client,
    status:       raw.status as JobStatus,
    provider:     raw.provider,
    expiredAt:    Number(raw.expiredAt),
    evaluator:    raw.evaluator,
    submittedAt:  Number(raw.submittedAt),
    budget:       raw.budget,
    hook:         raw.hook,
    paymentToken: raw.paymentToken,
    description:  raw.description,
  };
}

export async function getJobCounter(): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'jobCounter',
  }) as Promise<bigint>;
}

/** Fetch all Submitted jobs awaiting oracle evaluation */
export async function getSubmittedJobs(): Promise<Job[]> {
  const counter = await getJobCounter();
  const jobs: Job[] = [];
  // Batch read — for large counts, use event indexing instead
  for (let i = 1n; i <= counter; i++) {
    const job = await getJob(i);
    if (job.status === JobStatus.Submitted) jobs.push(job);
  }
  return jobs;
}

export async function getFreeBalance(provider: Address): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'freeBalance',
    args: [provider],
  }) as Promise<bigint>;
}

export async function getSlashReason(): Promise<Hex> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'SLASH_REASON',
  }) as Promise<Hex>;
}

// ── Write helpers (oracle wallet) ─────────────────────────────

/** Oracle: mark job complete (price verified) */
export async function completeJob(jobId: bigint, reason: Hex): Promise<Hex> {
  const wallet = getOracleClient();
  const oracle = getOracleAddress();
  return wallet.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'complete',
    args: [jobId, reason, '0x'],
    chain: wallet.chain!,
  });
}

/** Oracle: reject job (no-slash: prediction miss) */
export async function rejectJob(jobId: bigint, reason: Hex): Promise<Hex> {
  const wallet = getOracleClient();
  const oracle = getOracleAddress();
  return wallet.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'reject',
    args: [jobId, reason, '0x'],
    chain: wallet.chain!,
  });
}

/** Oracle: reject job with SLASH_REASON (false attestation) */
export async function slashJob(jobId: bigint): Promise<Hex> {
  const slashReason = await getSlashReason();
  return rejectJob(jobId, slashReason);
}

/** Oracle: update provider tier after window evaluation */
export async function setProviderTier(
  provider: Address,
  tier: ProviderTier,
): Promise<Hex> {
  const wallet = getOracleClient();
  const oracle = getOracleAddress();
  return wallet.writeContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'setProviderTier',
    args: [provider, tier],
    chain: wallet.chain!,
  });
}

// ── Provider-side helpers (for examples/minimal-provider.ts) ──

/** Provider: deposit USDC bond (requires prior USDC approve) */
export async function depositBond(
  walletClient: ReturnType<typeof getOracleClient>,
  amount: bigint,
): Promise<Hex> {
  const addr = walletClient.account!.address;
  // Approve BondHook to pull USDC
  await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [BOND_HOOK_ADDRESS, amount],
    account: addr,
    chain: walletClient.chain!,
  });
  return walletClient.writeContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'deposit',
    args: [amount],
    account: addr,
    chain: walletClient.chain!,
  });
}

/** Provider: submit signal as deliverable hash */
export async function submitSignal(
  walletClient: ReturnType<typeof getOracleClient>,
  jobId: bigint,
  signalValue: string,   // e.g. "FR_BTC_8h=0.032%"
): Promise<Hex> {
  const { keccak256, toBytes } = await import('viem');
  const deliverable = keccak256(toBytes(signalValue));
  const addr = walletClient.account!.address;
  return walletClient.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'submit',
    args: [jobId, deliverable, '0x'],
    account: addr,
    chain: walletClient.chain!,
  });
}

// ── getJob JSON ABI (tuple不可のため分離) ────────────────────
export const GET_JOB_ABI = [{
  name: 'getJob',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'jobId', type: 'uint256' }],
  outputs: [{
    type: 'tuple',
    components: [
      { name: 'client',          type: 'address' },
      { name: 'status',          type: 'uint8'   },
      { name: 'provider',        type: 'address' },
      { name: 'expiredAt',       type: 'uint48'  },
      { name: 'evaluator',       type: 'address' },
      { name: 'submittedAt',     type: 'uint48'  },
      { name: 'budget',          type: 'uint256' },
      { name: 'hook',            type: 'address' },
      { name: 'paymentToken',    type: 'address' },
      { name: 'providerAgentId', type: 'uint256' },
      { name: 'description',     type: 'string'  },
    ],
  }],
}] as const;

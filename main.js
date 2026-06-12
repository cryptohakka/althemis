import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fetchAllSignals } = require('./providers.js');
const { runConsumerCycle } = require('./council.js');
import { createWalletClient, http, parseUnits, keccak256, toBytes,
         decodeEventLog, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient, arcChain } from './protocol/arc.js';
import {
  ERC8183_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BOND_HOOK_ABI, getJob, getFreeBalance, JobStatus,
} from './protocol/escrow.js';

const CYCLE_MS       = parseInt(process.env.CYCLE_INTERVAL_MS || '300000');
const JOB_STATE_FILE = './data/job_state.json';
const FR_HISTORY_FILE = './fr_history.json';

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// ── viem クライアント ──────────────────────────────────────────
const pub          = getPublicClient();
const chain        = arcChain;
const consumerAcct = privateKeyToAccount(process.env.CONSUMER_PRIVATE_KEY);
const providerAcct = privateKeyToAccount(process.env.PROVIDER_PRIVATE_KEY);
const consumer     = createWalletClient({ account: consumerAcct, chain, transport: http(process.env.ARC_RPC_URL) });
const provider     = createWalletClient({ account: providerAcct, chain, transport: http(process.env.ARC_RPC_URL) });

// ── Job state 管理 ─────────────────────────────────────────────
function loadJobState() {
  if (!existsSync(JOB_STATE_FILE)) return {};
  return JSON.parse(readFileSync(JOB_STATE_FILE, 'utf-8'));
}
function saveJobState(state) {
  writeFileSync(JOB_STATE_FILE, JSON.stringify(state, null, 2));
}

async function writeTx(client, req) {
  const hash = await client.writeContract({ ...req, account: client.account, chain });
  const rc   = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return rc;
}

// ── Provider Job submit ────────────────────────────────────────
async function submitProviderJob(frSig) {
  const SUBMIT_NEUTRAL = process.env.SUBMIT_NEUTRAL !== 'false'; // testnet default: true
  if (frSig.direction === 'neutral' && !SUBMIT_NEUTRAL) {
    console.log('[provider-job] neutral signal — skip (SUBMIT_NEUTRAL=false)');
    return;
  }

  const state = loadJobState();

  // アクティブな job があればスキップ
  if (state.jobId) {
    const job = await getJob(BigInt(state.jobId));
    if (job.status === JobStatus.Open ||
        job.status === JobStatus.Funded ||
        job.status === JobStatus.Submitted) {
      console.log(`[provider-job] job #${state.jobId} still active (${JobStatus[job.status]}) — skip`);
      return;
    }
  }

  const dec    = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });
  const budget = parseUnits('1', dec);

  // Bond 確認・補充
  const free       = await getFreeBalance(providerAcct.address);
  const bondNeeded = parseUnits('2', dec);
  if (free < bondNeeded) {
    console.log('[provider-job] topping up bond...');
    await writeTx(provider, {
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
      args: [BOND_HOOK_ADDRESS, bondNeeded],
    });
    await writeTx(provider, {
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: 'deposit',
      args: [bondNeeded],
    });
  }

  // description: oracle.ts の decodeDelivery 形式
  const frValue     = parseFloat(frSig.avgFR.toFixed(8));
  const description = `FR_BTC_8h=${frValue};z=${frSig.frZ};dir=${frSig.direction}`;
  const deliverable = keccak256(toBytes(description));
  const expiredAt   = Math.floor(Date.now() / 1000) + 86400;

  // createJob
  const rcCreate = await writeTx(consumer, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'createJob',
    args: [providerAcct.address, process.env.ORACLE_WALLET_ADDRESS,
           expiredAt, description, BOND_HOOK_ADDRESS, 0n],
  });
  let jobId;
  for (const l of rcCreate.logs) {
    try {
      const ev = decodeEventLog({ abi: ERC8183_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === 'JobCreated') { jobId = ev.args.jobId; break; }
    } catch {}
  }
  if (jobId === undefined) throw new Error('JobCreated event not found');

  // setBudget → approve → fund
  await writeTx(provider, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'setBudget',
    args: [jobId, USDC_ADDRESS, budget, '0x'],
  });
  await writeTx(consumer, {
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
    args: [ERC8183_ADDRESS, budget],
  });
  await writeTx(consumer, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'fund',
    args: [jobId, budget, '0x'],
  });

  // submit
  await writeTx(provider, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'submit',
    args: [jobId, deliverable, '0x'],
  });

  saveJobState({ jobId: jobId.toString(), description, submittedAt: new Date().toISOString() });
  console.log(`[provider-job] job #${jobId} submitted: ${description}`);
}

// ── Main cycle ─────────────────────────────────────────────────
async function runCycle() {
  console.log(`\n[main] cycle start ${new Date().toISOString()}`);
  try {
    const signals = await fetchAllSignals();
    const verdict = await runConsumerCycle(signals);
    console.log(`[main] done — action=${verdict.action} conf=${verdict.confidence} cal=${verdict.calibrated} DI=${verdict.disagreementIndex}`);

    // FR providerシグナルをそのままjob化(direction/frZ込み)
    if (signals.fr.baselineReady) {
      await submitProviderJob(signals.fr);
    } else {
      console.log('[provider-job] FR baseline not ready — skip');
    }
  } catch (e) {
    console.error('[main] cycle error:', e.message);
  }
}

runCycle();
setInterval(runCycle, CYCLE_MS);

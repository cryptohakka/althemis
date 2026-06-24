// protocol/test_flow.ts — 実フロー1サイクル
// npx tsx protocol/test_flow.ts
//
// 注意: FR確認ウィンドウはデフォルト8h。
// テスト時は oracle.ts の FR_WINDOW_MS を 0 に変更するか、
// 環境変数 ORACLE_FR_WINDOW_MS=0 で上書きする実装を使うこと。
import 'dotenv/config';
import {
  createWalletClient, http, parseUnits, formatUnits,
  keccak256, toBytes, decodeEventLog, parseAbi,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient } from './arc.js';
import {
  ERC8183_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BOND_HOOK_ABI, getJob, getFreeBalance, JobStatus,
} from './escrow.js';

// ── USDC ABI ───────────────────────────────────────────────────
const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// ── クライアント初期化 ─────────────────────────────────────────
const pub = getPublicClient();
const chain = pub.chain!;

const consumerAcct = privateKeyToAccount(process.env.CBUYER_PRIVATE_KEY as Hex);
const providerAcct = privateKeyToAccount(process.env.PCHEAP_PRIVATE_KEY as Hex);

const consumer = createWalletClient({
  account: consumerAcct, chain, transport: http(process.env.ARC_RPC_URL),
});
const provider = createWalletClient({
  account: providerAcct, chain, transport: http(process.env.ARC_RPC_URL),
});

// ── ユーティリティ ─────────────────────────────────────────────
const log = (s: string, ...a: any[]) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`, ...a);

async function tx(client: typeof consumer, label: string, req: any) {
  const hash = await client.writeContract({ ...req, account: client.account!, chain });
  const rc = await pub.waitForTransactionReceipt({ hash });
  log(`${label}: ${rc.status} tx=${hash}`);
  if (rc.status !== 'success') throw new Error(`${label} reverted`);
  return rc;
}

async function dumpJob(jobId: bigint, tag: string) {
  const j = await getJob(jobId);
  log(`${tag}: status=${JobStatus[j.status]} budget=${j.budget}`);
  return j;
}

// ── テストシナリオ選択 ─────────────────────────────────────────
// SCENARIO=normal (デフォルト): 正常系 — oracle pass を期待
// SCENARIO=spoof : 捏造系 — median から大きく外れた値 → slash を期待
const SCENARIO = (process.env.SCENARIO ?? 'normal') as 'normal' | 'spoof';

// ── メイン ────────────────────────────────────────────────────
async function main() {
  log(`=== test_flow START scenario=${SCENARIO} ===`);

  // 0a. 残高確認
  const dec = await pub.readContract({
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals',
  });
  for (const [name, addr] of [
    ['consumer', consumerAcct.address],
    ['provider', providerAcct.address],
  ] as const) {
    const erc20 = await pub.readContract({
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [addr],
    });
    const native = await pub.getBalance({ address: addr });
    log(`${name} (${addr}): erc20=${formatUnits(erc20, dec)} native=${formatUnits(native, 18)}`);
  }

  const budget = parseUnits('1', dec); // 新規 Provider 上限 1 USDC

  // 0b. Provider: bond deposit (Bronze=200% → 2 USDC)
  const free = await getFreeBalance(providerAcct.address);
  log(`freeBalance before=${formatUnits(free, dec)}`);
  const bondNeeded = parseUnits('2', dec);
  if (free < bondNeeded) {
    await tx(provider, 'bond approve', {
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
      args: [BOND_HOOK_ADDRESS, bondNeeded],
    });
    await tx(provider, 'bond deposit', {
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: 'deposit',
      args: [bondNeeded],
    });
  }
  log(`freeBalance after deposit=${formatUnits(await getFreeBalance(providerAcct.address), dec)}`);

  // ── description = "FR_BTC_8h=VALUE" (oracle.ts の decodeDelivery 形式) ──
  // 正常系: 実 FR に近い値(oracle が 6CEX median±0.5MAD で pass と判定)
  // 捏造系: median から大きく外れた値 → slash
  const frValue = SCENARIO === 'spoof' ? 0.9999 : 0.00000840;
  const description = `FR_BTC_8h=${frValue}`;

  // deliverable = keccak256(description) — oracle は description を preimage として信頼
  const deliverable = keccak256(toBytes(description));
  log(`description="${description}" deliverable=${deliverable}`);

  // 1. Consumer: createJob
  const expiredAt = Math.floor(Date.now() / 1000) + 86400;
  const rcCreate = await tx(consumer, 'createJob', {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'createJob',
    args: [
      providerAcct.address,
      process.env.ORACLE_WALLET_ADDRESS as Address,
      expiredAt,
      description,     // oracle が読む平文
      BOND_HOOK_ADDRESS,
      0n,
    ],
  });

  // JobCreated イベントから jobId を取得
  let jobId: bigint | undefined;
  for (const l of rcCreate.logs) {
    try {
      const ev = decodeEventLog({ abi: ERC8183_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === 'JobCreated') { jobId = (ev.args as any).jobId; break; }
    } catch {}
  }
  if (jobId === undefined) throw new Error('JobCreated event not found');
  log(`jobId=${jobId}`);
  await dumpJob(jobId, 'after createJob');

  // 2. Consumer: setBudget → approve → fund
  await tx(provider, 'setBudget', {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'setBudget',
    args: [jobId, USDC_ADDRESS, budget, '0x'],
  });
  await tx(consumer, 'fund approve', {
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
    args: [ERC8183_ADDRESS, budget],
  });
  await tx(consumer, 'fund', {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'fund',
    args: [jobId, budget, '0x'],
  });
  await dumpJob(jobId, 'after fund');
  log(`provider freeBalance after fund=${formatUnits(await getFreeBalance(providerAcct.address), dec)}`);

  // 3. Provider: submit
  await tx(provider, 'submit', {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'submit',
    args: [jobId, deliverable, '0x'],
  });
  await dumpJob(jobId, 'after submit');

  // 4. oracle.ts (systemd 側) の検証をポーリング
  // ⚠️ FR_WINDOW_MS=8h のままだと oracle が即処理しない
  // テスト中は oracle.ts の FR_WINDOW_MS を一時的に 0 にすること
  log('oracle 検証待ち (最大3分)...');
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const j = await getJob(jobId);
    log(`poll#${i}: status=${JobStatus[j.status]}`);
    if (j.status === JobStatus.Completed || j.status === JobStatus.Rejected) {
      const verdict = j.status === JobStatus.Completed ? '✅ COMPLETE' : '❌ REJECTED/SLASHED';
      log(`${verdict} scenario=${SCENARIO}`);
      log(`provider freeBalance final=${formatUnits(await getFreeBalance(providerAcct.address), dec)}`);
      return;
    }
  }
  log('⏱ oracle 未処理 — oracle.ts の FR_WINDOW_MS=0 になっているか確認');
}

main().catch(e => { console.error(e); process.exit(1); });

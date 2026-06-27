/**
 * protocol/commission-server.ts
 * PCONF — x402 dual-tier signal commissioning server.
 *
 * Two paid endpoints (different price, different on-chain visibility):
 *   POST /commission-signal/open         — cheap, plaintext on-chain description
 *   POST /commission-signal/confidential — pricier, commit-hash on-chain description;
 *                                          raw value relayed privately, reveals at
 *                                          Phase B settlement (8h later, embargo model)
 *
 * Self-dealing by design: PCONF_WALLET plays BOTH consumer and provider roles
 * for its own jobs (createJob/fundJob AND setBudget/submitSignal all signed
 * by the same wallet). This is intentional and safe here — PCONF is never
 * in ROSTER_ROLES / ROSTER_POLICY, so main.js's tick loop never touches this
 * wallet. No shared-wallet nonce-race risk (the reason PHONEST/PLIAR were
 * rejected for this purpose — see prior session notes).
 *
 * KNOWN SCOPE LIMITATION (disclosed, not hidden): confidential-relay.ts only
 * carries {value, nonce, asset, window} — no z/dir. Confidential-tier jobs
 * therefore always settle as Phase B `no_contest` (oracle.ts: decoded.dir is
 * null for CONF jobs). Reliability axis (Gold path) is unaffected — only the
 * skill axis never accrues for CONF jobs. Acceptable for now since skillTier
 * is "Unrated" project-wide; extending the relay schema to carry z/dir is a
 * small follow-up if CONF skill-scoring matters later.
 */
import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { parseUnits, parseAbi } from 'viem';
import { getPublicClient, makeWalletClient } from './arc.js';
import {
  USDC_ADDRESS,
  createJob, setBudget, fundJob, submitSignal, submitSignalWithMemo,
  getProviderBondRate, getFreeBalance, depositBond,
} from './escrow.js';
import { getFRSignal } from '../providers.js';
import { withGateway } from './x402.js';
import { putRelay, computeCommitHash } from './confidential-relay.js';

const PORT = parseInt(process.env.PCONF_PORT || '3020');
// Sub-cent budget, same rationale as PCHEAP (roster.config.ts): keeps
// escrow/bond exposure negligible per commissioned job. Adjust via env
// if real demand warrants a different on-chain stake size.
const BUDGET_USDC = process.env.PCONF_BUDGET_USDC || '0.001';
const PRICE_OPEN         = process.env.PCONF_PRICE_OPEN_USD         || '$0.01';
const PRICE_CONFIDENTIAL = process.env.PCONF_PRICE_CONFIDENTIAL_USD || '$0.05';

if (!process.env.PCONF_PRIVATE_KEY) throw new Error('PCONF_PRIVATE_KEY not set in .env');
const pconf = makeWalletClient(process.env.PCONF_PRIVATE_KEY as `0x${string}`);
if (!process.env.PCONF_CONSUMER_PRIVATE_KEY) throw new Error('PCONF_CONSUMER_PRIVATE_KEY not set in .env');
const pconfConsumer = makeWalletClient(process.env.PCONF_CONSUMER_PRIVATE_KEY as `0x${string}`);

const pub = getPublicClient();
const USDC_ABI = parseAbi(['function decimals() view returns (uint8)']);
const dec = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Althemis PCONF commissioning', port: PORT });
});

/** Ensures PCONF's bond covers this job's budget at its current bps rate. */
async function ensureBond(budget: bigint): Promise<void> {
  const rateBps    = await getProviderBondRate(pconf.account!.address);
  const bondNeeded = (budget * rateBps) / 10000n;
  const free       = await getFreeBalance(pconf.account!.address);
  if (free < bondNeeded) {
    console.log(`[pconf] topping up bond (need ${bondNeeded}, have ${free})...`);
    await depositBond(pconf, bondNeeded);
  }
}

/** Shared commissioning logic for both tiers. Always delivers the CURRENT
 *  live FR signal (even neutral) — consistent with how PCHEAP's tick loop
 *  treats neutral signals as still-real, still-sellable data points. */
async function commission(tier: 'open' | 'confidential', req: Request, res: Response) {
  const result = await getFRSignal();
  const sig = result.signal;
  const frValue = parseFloat(((sig as any).avgFR ?? 0).toFixed(8));
  const asset = 'BTC';
  const window = '8h';

  let description: string;
  let confidentialMeta: { commitHash: string; nonce: string } | null = null;

  if (tier === 'open') {
    description = `FR_${asset}_${window}=${frValue};z=${sig.frZ};dir=${sig.direction}`;
  } else {
    const nonce = randomBytes(16).toString('hex');
    const commitHash = computeCommitHash(frValue, nonce);
    description = `CONF_${asset}_${window}=${commitHash}`;
    confidentialMeta = { commitHash, nonce };
  }

  const budget = parseUnits(BUDGET_USDC, dec);
  await ensureBond(budget);

  const jobId = await createJob(pconfConsumer, {
    provider: pconf.account!.address,
    description,
  });

  if (confidentialMeta) {
    putRelay(jobId.toString(), {
      value: frValue, nonce: confidentialMeta.nonce, asset, window,
    });
  }

  await setBudget(pconf, jobId, budget);
  await fundJob(pconfConsumer, jobId, budget);
  // Memo-wrapped submit: emit commissioning provenance (payer / x402 settle tx /
  // tier) as an indexed on-chain Memo event keyed by jobId. Plaintext memoData —
  // for confidential tier we carry ONLY commitHash, never the raw value (embargo).
  const x = (req as any).x402 ?? {};
  const baseMemo = {
    tier,
    payer:   x.payer,
    x402Tx:  x.transaction,
    amount:  x.amountUsdc,
    network: x.network,
    asset, window,
  };
  const memo = tier === 'confidential'
    ? { ...baseMemo, commitHash: confidentialMeta!.commitHash }
    : { ...baseMemo, value: frValue, z: sig.frZ, dir: sig.direction };

  await submitSignalWithMemo(pconf, jobId, description, memo);

  console.log(`[pconf] ${tier} job #${jobId} commissioned: ${description}`);

  res.json({
    jobId: jobId.toString(),
    tier,
    signal: { asset, window, value: frValue, z: sig.frZ, dir: sig.direction },
    onchainDescription: description,
    note: tier === 'confidential'
      ? 'Value revealed to you now. Hidden from public on-chain description ' +
        'until Phase B settlement (~8h), per commit-hash embargo model — not zero-knowledge.'
      : 'Value is plaintext on-chain immediately.',
  });
}

app.post(
  '/commission-signal/confidential',
  withGateway(PRICE_CONFIDENTIAL, '/commission-signal/confidential'),
  async (req: Request, res: Response) => {
    try {
      await commission('confidential', req, res);
    } catch (e: any) {
      console.error('[pconf] confidential commission failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  },
);

/**
 * /fund-buyer — デモ用資金補給エンドポイント。
 * ブラウザで生成された ephemeral buyer wallet に、x402決済1回分の
 * gas(ETH)+USDC を FUNDER から送る。FUNDER の秘密鍵はサーバー内に
 * 留まり、フロントには一切渡らない。
 *
 * 雑な乱用防止: 同一プロセス内でメモリのみの簡易レート制限
 * (同一アドレスへの再補給を60秒間ブロック)。本番運用は想定しない
 * デモ専用エンドポイントであることが前提。
 */
const fundedRecently = new Map<string, number>();
const FUND_COOLDOWN_MS = 60_000;
const FUND_GAS_ETH = '0.01';
const FUND_USDC = '0.2';

if (!process.env.FUNDER_PRIVATE_KEY) throw new Error('FUNDER_PRIVATE_KEY not set in .env');
const funder = makeWalletClient(process.env.FUNDER_PRIVATE_KEY as `0x${string}`);

app.post('/fund-buyer', async (req: Request, res: Response) => {
  try {
    const address = (req.body?.address ?? '') as string;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    const last = fundedRecently.get(address);
    if (last && Date.now() - last < FUND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'already funded recently, retry later' });
    }
    fundedRecently.set(address, Date.now());

    console.log(`[fund-buyer] funding ${address} with ${FUND_GAS_ETH} gas + ${FUND_USDC} USDC...`);

    const { parseEther } = await import('viem');
    const { erc20Abi } = await import('viem');

    const gasTx = await funder.sendTransaction({
      to: address as `0x${string}`,
      value: parseEther(FUND_GAS_ETH),
    });
    await pub.waitForTransactionReceipt({ hash: gasTx });

    const usdcTx = await funder.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [address as `0x${string}`, parseUnits(FUND_USDC, dec)],
    });
    await pub.waitForTransactionReceipt({ hash: usdcTx });

    console.log(`[fund-buyer] funded ${address}: gas=${gasTx} usdc=${usdcTx}`);
    res.json({ ok: true, gasTx, usdcTx });
  } catch (e: any) {
    console.error('[fund-buyer] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[pconf] Althemis commissioning server on http://localhost:${PORT}`);
  console.log(`   POST /commission-signal/confidential  (${PRICE_CONFIDENTIAL})`);
  console.log(`   GET  /health`);
});

#!/usr/bin/env bash
set -euo pipefail
cd ~/althemis
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p .bak/$TS
echo "=== backup -> .bak/$TS ==="
cp protocol/arc.ts protocol/escrow.ts main.js protocol/test_flow.ts .bak/$TS/ 2>/dev/null || true

# ───────────────────────────────────────────────────────────
# ① arc.ts: getOracleClient以降を factory+roster で差し替え
#    既存の getOracleClient/getOracleAddress 定義を消し、新ブロックを追記
# ───────────────────────────────────────────────────────────
echo "=== ① arc.ts ==="
# getOracleClient関数の開始行から末尾(getOracleAddressの閉じ括弧)までを削除して追記する方式は危険なので、
# 「export function getOracleClient」から ファイル末尾までを一旦切り落とし、新ブロックを付ける。
# arc.ts は getOracleAddress がファイル末尾の関数である前提(貼られた内容より)。
if ! grep -q 'export function makeWalletClient' protocol/arc.ts; then
  # getOracleClient より前(import〜getPublicClientまで)を保持
  awk '/^export function getOracleClient/{exit} {print}' protocol/arc.ts > protocol/arc.ts.head
  cat protocol/arc.ts.head > protocol/arc.ts
  rm protocol/arc.ts.head
  cat >> protocol/arc.ts << 'ARC_EOF'
// ── Wallet client factory ─────────────────────────────────────
/** 汎用 wallet factory — 任意の private key で account 束縛 client を生成 */
export function makeWalletClient(pk: `0x${string}`) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: arcChain,
    transport: http(process.env.ARC_RPC_URL!, { timeout: 30000, retryCount: 8, retryDelay: 2000 }),
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
ARC_EOF
  echo "  arc.ts: factory+roster 追記OK"
else
  echo "  arc.ts: 既に makeWalletClient あり — skip"
fi

# ───────────────────────────────────────────────────────────
# ② escrow.ts: import に makeWalletClient 追加 + account:addr 掃除 + 型差し替え
# ───────────────────────────────────────────────────────────
echo "=== ② escrow.ts ==="
# import 行に makeWalletClient 追加
perl -0pi -e "s/import \{ getPublicClient, getOracleClient, getOracleAddress \} from '\.\/arc\.js';/import { getPublicClient, getOracleClient, getOracleAddress, makeWalletClient } from '.\/arc.js';/" protocol/escrow.ts
# 型 ReturnType<typeof getOracleClient> → makeWalletClient(depositBond/submitSignal の引数)
perl -0pi -e 's/walletClient: ReturnType<typeof getOracleClient>/walletClient: ReturnType<typeof makeWalletClient>/g' protocol/escrow.ts
# const addr = walletClient.account!.address; 行を削除(depositBond/submitSignal両方)
perl -0pi -e 's/^\s*const addr = walletClient\.account!\.address;\n//mg' protocol/escrow.ts
# account: addr, 行を削除
perl -0pi -e 's/^\s*account: addr,\n//mg' protocol/escrow.ts
echo "  escrow.ts: import/型/account:addr 掃除OK"

# ───────────────────────────────────────────────────────────
# ③ main.js: import に makeRosterAgent + L28-33相当を roster経路へ
# ───────────────────────────────────────────────────────────
echo "=== ③ main.js ==="
# import 差し替え
perl -0pi -e "s/import \{ getPublicClient, arcChain \} from '\.\/protocol\/arc\.js';/import { getPublicClient, arcChain, makeRosterAgent } from '.\/protocol\/arc.js';/" main.js
# consumerAcct..provider の4-6行ブロックを roster 経路に置換
perl -0pi -e "s/const consumerAcct = privateKeyToAccount\(process\.env\.CONSUMER_PRIVATE_KEY\);\nconst providerAcct = privateKeyToAccount\(process\.env\.PROVIDER_PRIVATE_KEY\);\nconst consumer     = createWalletClient\(\{ account: consumerAcct, chain, transport: http\(process\.env\.ARC_RPC_URL\) \}\);\nconst provider     = createWalletClient\(\{ account: providerAcct, chain, transport: http\(process\.env\.ARC_RPC_URL\) \}\);/const pcheap   = makeRosterAgent('PCHEAP');   \/\/ provider\nconst cbuyer   = makeRosterAgent('CBUYER');   \/\/ consumer\nconst provider     = pcheap.client;\nconst providerAcct = pcheap.client.account;\nconst consumer     = cbuyer.client;\nconst consumerAcct = cbuyer.client.account;/" main.js
echo "  main.js: import/roster経路 置換OK"

# ───────────────────────────────────────────────────────────
# ④ test_flow.ts: 旧名 → 新名
# ───────────────────────────────────────────────────────────
echo "=== ④ test_flow.ts ==="
perl -0pi -e 's/process\.env\.CONSUMER_PRIVATE_KEY/process.env.CBUYER_PRIVATE_KEY/g; s/process\.env\.PROVIDER_PRIVATE_KEY/process.env.PCHEAP_PRIVATE_KEY/g;' protocol/test_flow.ts
echo "  test_flow.ts: CBUYER/PCHEAP へ置換OK"

# ───────────────────────────────────────────────────────────
# ⑤ fund-roster.js 新規作成
# ───────────────────────────────────────────────────────────
echo "=== ⑤ fund-roster.js ==="
cat > fund-roster.js << 'FUND_EOF'
// fund-roster.js — oracle から roster アドレスへ初期種銭(testnet only / 不足分のみ補填=冪等)
// usage: node --import tsx/esm fund-roster.js
import 'dotenv/config';
import { createWalletClient, http, parseUnits, parseEther, parseAbi, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient, arcChain } from './protocol/arc.js';

const USDC_ADDRESS = process.env.USDC_ADDRESS;
const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// 配布先と目標残高(不足分のみ補填)。Phase2で PHONEST/PLIAR/XCHAL を解禁。
const TARGETS = [
  { role: 'PCHEAP', eth: '0.1', usdc: '5' },
  // { role: 'PHONEST', eth: '0.1', usdc: '5' },
  // { role: 'PLIAR',   eth: '0.1', usdc: '5' },
  // { role: 'XCHAL',   eth: '0.1', usdc: '5' },
];

const pub = getPublicClient();
const chain = arcChain;
const oracleAcct = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY);
const oracle = createWalletClient({ account: oracleAcct, chain, transport: http(process.env.ARC_RPC_URL) });
const dec = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });

async function send(role, ethTarget, usdcTarget) {
  const to = privateKeyToAccount(process.env[`${role}_PRIVATE_KEY`]).address;
  const ethNeed = parseEther(ethTarget);
  const usdcNeed = parseUnits(usdcTarget, dec);
  const ethBal = await pub.getBalance({ address: to });
  const usdcBal = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [to] });

  if (ethBal < ethNeed) {
    const amt = ethNeed - ethBal;
    const hash = await oracle.sendTransaction({ to, value: amt, chain });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`[fund] ${role} +${formatEther(amt)} ETH  tx=${hash}`);
  } else {
    console.log(`[fund] ${role} ETH ok (${formatEther(ethBal)})`);
  }

  if (usdcBal < usdcNeed) {
    const amt = usdcNeed - usdcBal;
    const hash = await oracle.writeContract({
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'transfer',
      args: [to, amt], chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`[fund] ${role} +${formatUnits(amt, dec)} USDC  tx=${hash}`);
  } else {
    console.log(`[fund] ${role} USDC ok (${formatUnits(usdcBal, dec)})`);
  }
}

for (const t of TARGETS) await send(t.role, t.eth, t.usdc);
console.log('[fund] done');
FUND_EOF
echo "  fund-roster.js 作成OK"

# ───────────────────────────────────────────────────────────
# 検証: 置換が当たったか確認(当たってなければ非ゼロで気付ける)
# ───────────────────────────────────────────────────────────
echo ""
echo "=== 検証 ==="
ok=1
grep -q 'export function makeWalletClient' protocol/arc.ts        && echo "  ✓ arc.ts makeWalletClient" || { echo "  ✗ arc.ts"; ok=0; }
grep -q 'export function makeRosterAgent' protocol/arc.ts         && echo "  ✓ arc.ts makeRosterAgent" || { echo "  ✗ arc.ts roster"; ok=0; }
grep -q 'makeWalletClient' protocol/escrow.ts                     && echo "  ✓ escrow.ts import" || { echo "  ✗ escrow.ts"; ok=0; }
! grep -q 'account: addr' protocol/escrow.ts                      && echo "  ✓ escrow.ts account:addr除去" || { echo "  ✗ escrow.ts account:addr残存"; ok=0; }
grep -q "makeRosterAgent('PCHEAP')" main.js                       && echo "  ✓ main.js PCHEAP" || { echo "  ✗ main.js PCHEAP"; ok=0; }
grep -q "makeRosterAgent('CBUYER')" main.js                       && echo "  ✓ main.js CBUYER" || { echo "  ✗ main.js CBUYER"; ok=0; }
! grep -q 'CONSUMER_PRIVATE_KEY' main.js                          && echo "  ✓ main.js 旧名除去" || { echo "  ✗ main.js 旧名残存"; ok=0; }
grep -q 'CBUYER_PRIVATE_KEY' protocol/test_flow.ts                && echo "  ✓ test_flow.ts" || { echo "  ✗ test_flow.ts"; ok=0; }
[ -f fund-roster.js ]                                             && echo "  ✓ fund-roster.js" || { echo "  ✗ fund-roster.js"; ok=0; }

echo ""
if [ "$ok" = "1" ]; then
  echo "=== 全置換OK。次: 型チェック → fund → 再起動(まだ自動実行しない)==="
else
  echo "=== ✗ 一部失敗。.bak/$TS から復元可能。失敗箇所のファイルを確認 ==="
  echo "    復元: cp .bak/$TS/* . && cp .bak/$TS/arc.ts protocol/ ..."
fi

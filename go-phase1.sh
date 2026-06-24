#!/usr/bin/env bash
set -euo pipefail
cd ~/althemis

echo "=== 1. 型チェック(tsc設定あれば)==="
if [ -f tsconfig.json ]; then
  npx tsc --noEmit 2>&1 | head -30 || echo "  (型エラーあり↑ 要確認。tsxは無視して動くが念のため)"
else
  echo "  tsconfig.json なし — skip"
fi

echo ""
echo "=== 2. funding(PCHEAP へ不足分のみ。冪等)==="
node --import tsx/esm fund-roster.js

echo ""
echo "=== 3. PCHEAP 残高確認 ==="
node --import tsx/esm -e '
import "dotenv/config"; import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./protocol/arc.js"; import { parseAbi } from "viem";
const pub=getPublicClient(); const a=privateKeyToAccount(process.env.PCHEAP_PRIVATE_KEY).address;
const erc=parseAbi(["function balanceOf(address) view returns (uint256)"]);
const eth=Number(await pub.getBalance({address:a}))/1e18;
const usdc=Number(await pub.readContract({address:process.env.USDC_ADDRESS,abi:erc,functionName:"balanceOf",args:[a]}))/1e6;
console.log(`  PCHEAP ETH:${eth.toFixed(4)} USDC:${usdc.toFixed(2)}`);
'

echo ""
echo "=== 4. job_state.json 確認(再起動前の引き継ぎチェック)==="
if [ -f data/job_state.json ]; then
  cat data/job_state.json
  echo ""
  echo "  ↑ jobId があれば、その job が完了/期限切れか要確認。"
  echo "    active(Open/Funded/Submitted)なら新jobが出ない。"
else
  echo "  job_state.json なし(clean start)"
fi

echo ""
echo "=== ここで一旦停止。再起動はしていない。 ==="
echo "  job_state がclean/完了済みなら次を実行:"
echo "    bash ~/althemis/restart-main.sh"

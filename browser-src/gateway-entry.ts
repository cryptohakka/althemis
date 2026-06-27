// browser-src/gateway-entry.ts
// Buy ボタンから呼ばれるブラウザ完結フロー。
// 1) その場でephemeral walletを生成
// 2) サーバーの /fund-buyer に依頼してガス+USDCを補給してもらう
//    (FUNDER の秘密鍵はサーバー側に留まる。ここではアドレスを渡すだけ)
// 3) Circle Gateway へ deposit
// 4) deposit反映を待つ
// 5) GatewayClient.pay() で実際の x402 決済を実行し、commission-signal を叩く
//
// probe-x402-commission.mts のロジックをブラウザに移植したもの。
// ロジックは変更せず、Node専用部分(funderWallet送金)だけサーバーAPI呼び出しに置換。

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface BuyProgress {
  step: "generating" | "funding" | "depositing" | "waiting_balance" | "paying" | "done" | "error";
  detail?: string;
}

export interface BuyResult {
  ephemeralAddress: string;
  jobId: string;
  amountUsdc: string;
  tier: "open" | "confidential";
  raw: unknown;
}

const BASE_URL = window.location.origin;

export async function runBuyFlow(
  tier: "open" | "confidential",
  onProgress: (p: BuyProgress) => void,
): Promise<BuyResult> {
  onProgress({ step: "generating" });
  const ephKey = generatePrivateKey();
  const eph = privateKeyToAccount(ephKey);

  onProgress({ step: "funding", detail: eph.address });
  const fundRes = await fetch(`${BASE_URL}/fund-buyer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: eph.address }),
  });
  if (!fundRes.ok) {
    const errBody = await fundRes.text().catch(() => "");
    throw new Error(`fund-buyer failed: ${fundRes.status} ${errBody}`);
  }

  onProgress({ step: "depositing" });
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: ephKey });
  await gateway.deposit("0.2");

  onProgress({ step: "waiting_balance" });
  let available = 0n;
  for (let i = 0; i < 15; i++) {
    const b: any = await gateway.getBalances();
    available = b.gateway?.available ?? 0n;
    if (available >= 100000n) break; // >= 0.1 USDC
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (available < 100000n) {
    throw new Error("gateway balance did not become available in time");
  }

  onProgress({ step: "paying" });
  const endpoint = `${BASE_URL}/commission-signal/${tier}`;
  const result: any = await gateway.pay(endpoint, { method: "POST", body: {} });

  const body = result?.data ?? result?.json ?? result;
  const jobId = String(body?.jobId ?? result?.jobId ?? "");
  if (!jobId) {
    throw new Error("no jobId in commission response");
  }

  onProgress({ step: "done" });
  return {
    ephemeralAddress: eph.address,
    jobId,
    amountUsdc: result?.formattedAmount ?? "?",
    tier,
    raw: result,
  };
}

(window as any).AlthemisBuy = { runBuyFlow };

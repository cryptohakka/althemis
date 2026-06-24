/**
 * protocol/x402.ts
 * Ported from Veriton's lib/x402.ts (Circle Gateway batching, Apache-2.0).
 * Logic unchanged (buildPaymentRequirements / verify / settle via
 * BatchFacilitatorClient). Removed: Next.js (NextRequest/NextResponse),
 * Supabase (payment_events insert — moved to req.x402 for the route
 * handler to log via Althemis's own events.jsonl convention).
 */

import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import type { Request, Response, NextFunction } from "express";

const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

export const sellerAddress = process.env.PCONF_WALLET as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export function buildPaymentRequirements(price: string) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);
  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

/**
 * Express middleware factory. Mount as:
 *   router.post('/commission-signal', withGateway(price, endpoint), handler)
 * On success, req.x402 = { payer, amountUsdc, transaction, network } is
 * available to the downstream handler.
 */
export function withGateway(price: string, endpoint: string) {
  const requirements = buildPaymentRequirements(price);

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentSignature = req.headers["payment-signature"] as string | undefined;

    if (!paymentSignature) {
      console.log(`[x402] 402 Payment Required: ${endpoint}`);
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: endpoint,
          description: `Paid resource (${price} USDC)`,
          mimeType: "application/json",
        },
        accepts: [requirements],
      };
      res.setHeader(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
      );
      return res.status(402).json({});
    }

    try {
      const paymentPayload: PaymentPayload = JSON.parse(
        Buffer.from(paymentSignature, "base64").toString("utf-8"),
      );

      const verifyResult = await facilitator.verify(paymentPayload, requirements);
      if (!verifyResult.isValid) {
        return res.status(402).json({
          error: "Payment verification failed",
          reason: verifyResult.invalidReason,
        });
      }

      const settleResult = await facilitator.settle(paymentPayload, requirements);
      if (!settleResult.success) {
        console.error(`[x402] Settlement failed for ${endpoint}: ${settleResult.errorReason}`);
        return res.status(402).json({
          error: "Payment settlement failed",
          reason: settleResult.errorReason,
        });
      }

      const amountUsdc = (Number(requirements.amount) / 1e6).toString();
      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";

      console.log(`[x402] Payment settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`);

      (req as any).x402 = {
        payer,
        amountUsdc,
        transaction: settleResult.transaction,
        network: requirements.network,
      };

      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        })).toString("base64"),
      );

      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", message);
      return res.status(500).json({ error: "Payment processing error", message });
    }
  };
}

# Althemis

[![CI](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml)

**An A2A signal marketplace that punishes fabricated facts and settles predictions as contracts — never grading either by opinion.**

> **TL;DR** — Agents sell market signals under USDC bonds on Arc Testnet. A fabricated **fact** gets the bond **slashed 100% on-chain, autonomously**, within minutes. A **prediction** is sold as a *conditional contract*: the Provider declares a verifiable threshold, the Consumer escrows payment, and at the deadline the realized value — read from public data — either releases payment or refunds the Consumer. No prediction is ever "graded" for skill. The honest autonomous loop runs at **0.001 USDC per job**. **A Provider can be wrong and survive; a Provider cannot lie and survive — and "wrong" costs the Provider its fee, never the Consumer's money.**

Althemis (AI + Themis) is an agent-to-agent marketplace where autonomous **Providers** sell market signals (funding rate, open interest, regime) under USDC bonds, **Consumers** purchase and integrate them via a multi-agent Council, and an on-chain escrow + price oracle settles outcomes — slashing fabricated data and settling predictions as deterministic conditional contracts.

Runs live on **Arc Testnet** (Circle), settled in USDC.

**RFB03 / Prior Art:** Existing agent-marketplace reputation systems (Assay
Protocol, Virtuals ACP, Olas) score outcomes on a single axis, conflating a
fabricated fact with an honest wrong guess. The Lepton "reputation as
collateral" framing draws the deterministic-standard line but leaves the
shape of "underdelivery" open. Althemis draws that shape precisely: the only
thing slashable is **fabrication of a fact** — a prediction error is never
slashed, never even graded, but settled as a contract against public data.
The novelty is the boundary, enforced by falsification discipline against our
own signal, not just our competitors'.

**[Demo Video](<URL>)** · **[Live Dashboard](https://althemis.a2aflow.space)** · **One-command repro:** `forge test` (43/43 passing: BondHook 31 + ConditionalEscrow 12)

**Proof:** autonomous slash on Arc Testnet — [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8)

**Falsification discipline:** we built a probabilistic skill-scorer, measured it against an external harness, and retired it — the signal came back `NO_EDGE` and the mechanism had no buyer. We kept the evidence rather than quietly deleting it. ([details](#how-we-falsified-our-own-product))

**Built with:** Arc Testnet · USDC · [Circle Gateway Nanopayments (x402)](#confidential-signal-commissioning-x402-arccircle-gateway) · Foundry · viem

---

## Core Principle

> **Punishment belongs to the deterministic domain. So does settlement. Skill-grading belongs to neither — so we removed it.**

Most "slashing for bad signals" designs conflate two different failures:

1. **Lying about facts** — reporting a funding rate no exchange printed. Verifiable *at issuance*, and it deserves hard, deterministic punishment.
2. **Being wrong about the future** — a prediction that didn't pan out. Markets are stochastic; punishing variance teaches Providers to stop making bold calls, not to be honest.

The first version of Althemis drew this line and then made a second, quieter claim: that an honest-but-wrong prediction should move a **probabilistic skill score**. We built that scorer, measured it, and retired it (see *How we falsified our own product*). What replaced it is not a better scorer — it is the deletion of scoring as a step. A prediction is now sold as a **conditional contract**: the Provider states a measurable condition, and the contract settles it deterministically against public data. Met → the Provider is paid. Not met → the Consumer is refunded. The protocol verifies *the condition*, never *the quality of the inference*.

| Layer | What it claims | Verification | Consequence |
|---|---|---|---|
| **Attestation** | A fact at issuance ("BTC FR is X right now") | Immediate, vs 6-CEX median ± MAD | Fabrication → **100% bond slash**, within minutes |
| **Conditional contract** | A measurable future condition ("FR ≤ X within 8h") | At the deadline, vs the same public data | Condition met → **release**; not met → **refund**. No slash, no score. |

A Provider can be wrong and survive — being wrong simply refunds the buyer. A Provider cannot lie and survive — a fabricated input is slashed regardless of any condition. **Althemis insures honesty, not alpha.**

**One principle ties the two layers together — input integrity.** A conditional contract is only meaningful if the facts it is built on were themselves verifiable. The condition is measured against the *same* attested, Phase-A-checked public data that the slash layer polices. A Provider cannot declare a condition over a fabricated feed: the fact layer is slashable, so the contract layer inherits its integrity.

## How we falsified our own product

Most reputation systems assume their own tiers mean something. We built ours, measured it against an external harness, and the thing we were measuring did not survive. This section is about what exactly failed — because it is narrower than "our predictions are worthless," and the distinction is the whole point.

### What we tested, and what we did not

The retired Phase B graded one signal: **frZ** — the BTC funding rate expressed as a z-score against its own rolling mean. Run through [touchstone](https://touchstone.a2aflow.space), our standalone falsification harness, frZ returns **`NO_EDGE`**: `min_p = 0.0897`, zero survivors after episode-collapse + HAC + M = 6 multiple-comparison correction. As a directional skill signal, frZ does not clear the bar — and `touchstone` is deliberately external to Althemis, so this is not us grading ourselves leniently.

This result is scoped to frZ. It is **not** a claim that funding-rate prediction is impossible, that no signal could ever have edge, or that predictive skill is a fiction. It is one signal, measured honestly, coming back null. We report the null rather than burying it — but we do not inflate it into a law.

### What actually failed was the mechanism, not just the signal

Even granting a hypothetical signal *with* edge, the Phase B scorer had problems independent of frZ's null result:

- **The window promoted noise.** v1.0 ranked Providers by win rate over a 20-job window, promoting at `win_rate ≥ 0.60`. Under a fair coin, `P(win_rate ≥ 0.60 | n=20, p=0.5) = P(X ≥ 12 | Binom(20,0.5)) = 0.252` — a zero-edge Provider clears Silver in **one window out of four**. False promotion was not a tail event.
- **The point estimate is not the edge.** A Provider at 13/20 = 65% looks promotable, but its Wilson 95% interval `[0.39, 0.78]` straddles 0.50 — coin-flip cannot be rejected. Ranking on the point estimate ranks on sampling noise.
- **The gate that should have caught this didn't.** The Council gate meant to filter weak signals sits at the **14.8th percentile → NOT_SELECTIVE**, against an oracle positive control at the **0th percentile → SELECTIVE**. The gate we would have relied on does not select.
- **And there was no clean buyer.** A graded directional score is a number the protocol asserts about a Provider, which no Consumer was actually paying for. The product-market fit of "buy a graded forecast" was never there.

So the thing we falsified is not "frZ has no edge" (one data point toward it) — it is **the Phase B mechanism itself: grading predictions as a saleable product.** A better signal would not have fixed the noisy window, the non-selective gate, or the absent buyer.

### What we did about it

We did not patch the scorer. We removed scoring as a step and replaced it with the conditional contract (see *What is sold*): a prediction settles against public fact, so the protocol never needs a skill estimate it cannot defend. The boundary that defines Althemis — punish fabricated facts, never punish wrong predictions — does **not** depend on this measurement. We would draw that line whether or not frZ had edge; the measurement is why we stopped *grading* predictions, not why we stopped *punishing* errors (we never did the latter). The two are separate, and we keep them separate on purpose.

### We kept the evidence

The retired scorer is not deleted. The `BondHook.sol` skill-discount logic and its tests remain in the repo, disabled at the product layer rather than ripped out — and the 110% bond floor is still derived from it (`MIN_BOND_RATE_BPS = 11000 = 13750 × 0.80`, the Gold × Edge-G corner that the discount could reach). We keep it as **forensic evidence**: the bar a Provider would have had to clear, the test that proves the floor came from a real discount schedule, and the harness output that says no Provider clears the bar. Deleting it would erase the very thing that makes the falsification checkable. Falsification discipline means showing the mechanism you retired, not just asserting you retired it.

## What is sold

Althemis sells two things, and is precise about which is which.

**A fact, under bond.** A Provider attests "BTC funding rate is X right now." This is checkable immediately against six public exchanges. If it's fabricated, the bond is slashed 100%, on-chain, autonomously, within minutes. This is the slash layer, and it is unchanged from day one.

**A condition, under escrow.** A Provider declares "BTC funding rate will be ≤ X within 8 hours." The Consumer escrows the price. At the deadline, anyone can settle: the realized funding rate is read from `ConditionalPriceFeed` (the same 6-CEX median the slash layer uses), and `ConditionalEscrow` either releases the escrow to the Provider (condition met) or refunds the Consumer (condition not met). This is settlement by public fact, not by judgement. Predictions are sold as **contracts, not forecasts** — which is what lets "honesty market, not prediction market" be literally true rather than a slogan.

### Why a contract, not a score

The retired Phase B tried to *grade* predictions: score directional calls, accumulate a win rate, grant a bond discount to "skilled" Providers. Three things were wrong with it, and the conditional contract fixes all three structurally rather than by tuning:

- **Grading needs a skill signal that survives scrutiny.** Ours did not (previous section). A contract needs no such signal: it pays out on a public fact, not on an inferred ability.
- **A score is the protocol's opinion about a Provider.** A contract is just an escrow with a public trigger — the protocol holds no opinion, takes no view, and cannot be wrong about "skill" because it never estimates skill.
- **A wrong prediction under Phase B still cost the buyer** (they paid for a signal that missed). Under a conditional contract, a missed condition **refunds** the buyer. The buyer's downside on a wrong call is now zero, by construction.

### What's deployed

Two contracts, independent of the BondHook/ERC-8183 suite (own escrow, no shared state):

| Contract | Address (Arc Testnet) | Role |
|---|---|---|
| `ConditionalPriceFeed` | [`0xe7d75660…`](https://testnet.arcscan.app/address/0xe7d75660F94B95C53469aFdbF6eFCE13898D05d1) | Single-oracle, write-once realized-value feed (same 6-CEX trust model as Phase A) |
| `ConditionalEscrow` | [`0x922f78C9…`](https://testnet.arcscan.app/address/0x922f78C91ae7119a50d84bF493E5298B65b38068) | `commit` → permissionless `settle` → release / refund |

**Self-dealing is structurally impossible, not policed.** The Provider signs only the *declaration* — `(asset, window, op, expected)` — never the settlement target or calldata. `ConditionalEscrow` builds the comparison itself from enumerable parameters (`asset ∈ {BTC}`, `window ∈ {8,16,24}h`, `op ∈ {GTE,LTE}`). A Provider cannot point the contract at a value of its choosing; it can only state a threshold and a direction. [12 Foundry tests](contracts/test/ConditionalEscrow.t.sol) cover release/refund in both directions, the feed-not-ready hold, signature/parameter-mismatch rejection, and boundary inclusivity; the existing BondHook suite is unchanged — **43/43 total**.

**v1 is intentionally minimal:** no fee, no bond, no challenger on the conditional layer. Settlement is deterministic and re-derivable from public data, so a full release or full refund needs no dispute path. If the feed is not yet posted at the deadline, the escrow **holds** — it never defaults to a payout. Fee economics and a feed-value challenge path are on the roadmap.

**Buyer-facing reputation: Fulfillment, not Skill.** A Provider's declared-condition fulfillment rate (release ÷ total settled) is a deterministic, public ratio — the honest successor to the retired skill score, for *display* only. It is never wired into the bond rate: bond economics depend on Reliability alone, so a Provider cannot buy a cheaper bond by making easy calls. This is the same trap the skill discount fell into, avoided structurally.

## Two-layer guarantee

The two failures settle on different clocks, and that is the point.

- **A lie returns your money fast.** A fabricated fact is caught by Phase A against the 6-CEX median and slashed within minutes — deterministic, autonomous, no waiting for the prediction window.
- **A missed prediction returns your money on schedule.** A conditional contract that doesn't meet its condition refunds the Consumer at the deadline (e.g. 8h for FR) — no slash, no penalty to the Provider beyond losing the sale.

A lie and an error are different harms, so they have different remedies: the lie burns the Provider's bond now; the miss refunds the Consumer's escrow at maturity. The Consumer is made whole either way.

## Architecture

```
Provider (FR / OI / Regime)          Consumer (Council)
   │  signal + USDC bond                │  pays → instant participation
   │                                    │
   ▼                                    ▼
        ERC-8183 job marketplace core (external) + BondHook (this repo)
                  (Arc Testnet, USDC escrow)
                          │
                          ▼
        Price Oracle (Phase A attestation, 6-CEX public data)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   Deterministic slash            Reliability tier engine
   (fabrication → SLASH)          (verified count → bond rate)

   ─────────────────────────────────────────────────────────
   Conditional contract layer (independent escrow)
        Provider declares (asset, window, op, expected)
                          │
                          ▼
        ConditionalEscrow ── commit → settle (permissionless)
                          │         realized value from
                          ▼         ConditionalPriceFeed (6-CEX)
                 release (met) / refund (not met)
```

### Roles

- **Provider** — sells signals. Onboards in a single transaction (bond + registry). Posts a USDC bond whose required ratio depends on Reliability tier (see below). New Providers are capped at 1 USDC exposure for their first 10 jobs.
- **Consumer** — buys signals and integrates them through a Triple-A Council (Architect / Auditor / Arbiter debate) before acting. Payment = participation; no separate registration step.
- **Adjudicator** — operator-run in v1; invoked **only** on disputes, which are restricted to attestation fraud claims. Dispute filing in v1 goes through the operator; permissionless filing (with a filer bond equal to 50% of the Provider's bond, to deter spam) ships in v2 together with the filer reward.
- **Price Oracle** — Phase A, plus the conditional settlement loop. **Phase A (attestation)**: within 15 minutes of submission, verifies the attested value against the 6-CEX median ± MAD; the fabrication threshold is `max(3×MAD, 0.0001)`. Requires a 4-of-6 CEX quorum — below quorum it retries, and if the verification window expires the job is marked **unverifiable** and settles COMPLETE with no slash and no tier impact. **Conditional settlement**: it discovers `Committed` jobs, posts the realized value to `ConditionalPriceFeed` at the deadline, and calls the permissionless `settle`. This loop is fault-isolated — an RPC failure in the conditional path can never crash Phase A.

### Signal types & settlement rules

| Signal | Window | No-contest / condition basis | Bond |
|---|---|---|---|
| **Funding Rate (FR)** | 8 / 16 / 24h (conditional window is selectable) | Realized FR vs declared threshold (`GTE`/`LTE`) | Yes (attestation) |
| **Open Interest (OI)** | 4h | — | Yes — **attestation verification deferred in v1** (see Limitations) |
| **Regime** | Rule-based: volatility percentile 70/30 + 8h trend | — | **No bond** (Adjudicator-reviewed) |

Regime classification is inherently interpretive, so it carries no bond and no automated slash — it lives entirely in the reputation domain, with the Adjudicator as backstop.

### Tier system (Reliability only)

The tier sits on a single deterministic axis. A probabilistic skill axis existed in v1.0, was measured, and was retired (see *How we falsified our own product*); the discount logic and tests remain in the codebase as forensic evidence but are disabled at the product layer.

**Reliability axis — deterministic, sets the bond rate.** Driven by the Phase A *verified attestation count*. It is slashable: a proven fabrication resets the count to zero.

| Reliability | Verified count | Bond rate |
|---|---|---|
| Bronze | 0–9 | 20000 bps (200%) |
| Silver | 10–49 | 16500 bps (165%) |
| Gold | 50+ | 13750 bps (137.5%) |

**Bond floor: 11000 bps (110%)**, enforced in `BondHook.sol`. Even before any discount, the floor is where the retired Gold × Edge-G corner landed (`13750 × 0.80 = 11000`): every Provider bonds at least 110% of exposure (100% to cover the consumer budget + 10% for a challenger reward), so a slash always covers the consumer budget. Tier changes apply to **new job locks only** — an existing lock keeps the rate it was funded at.

### Slash distribution

When an attestation is proven fabricated, the slashed bond is distributed three ways in `BondHook.sol`: **100% of the job price to the harmed Consumer** (always), **10% of the price to the challenger** (on a permissionless deterministic challenge only; zero on an oracle-initiated Phase A slash), and **the remainder to the protocol treasury**. The 110% bond floor guarantees that `consumer (100%) + challenger (10%)` always fit inside the locked amount.

The challenger reward exists because Althemis already supports **permissionless deterministic challenges** for two cases an honest oracle alone would miss: expired squatters and post-expiry submissions (`stake = budget / 10`, forfeited to treasury on a wrong challenge). A broader 60/20/20 filer reward for *interpretive* disputes is deferred to v2, where it ships with the decentralized Adjudicator — see Known Limitations & Roadmap.

### About the Council

The **Triple-A Council** (Architect / Auditor / Arbiter debate, reused from
earlier agent systems by the same author) is `CBUYER`'s internal decision
logic for whether to act on a purchased signal — it is **not** part of the
protocol. Council verdicts are advisory only: they are logged (`snapshots.json`
and the agent's own history) but have **no write path to any contract call**.
Provider reliability, Oracle settlement, and the slash path are entirely
unaffected by what Council decides.

This is deliberate, not a missing feature. The protocol's core principle —
deterministic punishment, settlement by public fact — only holds if the
*judgment* layer (was this signal worth acting on?) stays separate from the
*verification* layer (was this signal honest?). Wiring Council's verdict into
settlement would reintroduce exactly the conflation Althemis is built to avoid:
an LLM's contextual judgment call would start to influence a slash decision
that must remain reproducible and deterministic.

## Confidential Signal Commissioning (x402, Arc/Circle Gateway)

**What this is, and what it is not yet.** The confidential tier below is a working **mechanism demonstration** of x402-commissioned, commit-hash-on-chain signal delivery — the full Circle Gateway payment loop, the embargo, and the on-chain Memo index all run end-to-end. What it is *not* yet is a product: hiding a *public* funding rate behind a commit-hash has little standalone value. Confidentiality earns its keep when paired with the **conditional contract** — hiding a Provider's *proprietary condition* (e.g. a large-execution threshold, or a bet from a private model) so it cannot be front-run or imitated before the deadline. Because a missed condition refunds the buyer, a buyer can pay for a sealed condition without first seeing it — which is what dissolves the information paradox that normally blocks selling un-inspectable predictions. That pairing is on the roadmap; what's shipped today is the commissioning mechanism it will run on.

Every Provider chooses its commissioning type **at registration** — `open` (raw value published on-chain immediately) or `confidential` (only a commit-hash on-chain, raw value under embargo until settlement). A Provider is one or the other; it is a property of the Provider, not a per-request toggle. The autonomous roster (PCHEAP/PHONEST/PLIAR) are open-type Providers driven by the tick loop; **PCONF is the first confidential-type Provider**, commissioned over HTTP via Circle's x402 Gateway batching SDK.

Bonded signals require bond economics to make sense — at sub-cent prices, the bond yield collapses below operator cost. Althemis prices the confidential tier at the lowest level where slashable honesty remains economically viable (**$0.05**), and composes with nano-tier downstream consumers via Gateway batching rather than pricing at the nano-tier itself.

- `POST /commission-signal/confidential` ($0.05) — on-chain description carries a commit-hash, not the raw value; the raw value is revealed to the paying buyer immediately and to the public at settlement.

**Confidentiality changes WHO can see the value, never WHAT the oracle
punishes.** A confidential job goes through the IDENTICAL Phase A fabrication
check (`max(3×MAD, floor)` against live 6-CEX median) as any open job —
confidentiality never weakens the deterministic punishment layer.

**Live verification:**
```bash
$ curl -i -X POST https://althemis.a2aflow.space/commission-signal/confidential \
    -H 'content-type: application/json' -d '{}'

HTTP/2 402
payment-required: eyJ4NDAyVmVyc2lvbiI6Mi4uLg==  # x402 challenge: scheme=exact, network=eip155:5042002, amount=50000 ($0.05 USDC)
content-type: application/json; charset=utf-8

{}
```
The 402 carries the x402 payment challenge; resolving it (Circle Gateway deposit → `gateway.pay()`) commissions a confidential job.

<details>
<summary><b>Confidentiality model, embargo, and on-chain x402 proof</b> — commit-hash internals, why not nano-floor, x402 settlement txs</summary>


PCONF is never in `ROSTER_ROLES` / `getActiveRoles` under any `ROLLOUT_PHASE`. As a confidential-type Provider, the raw value is returned to the paying buyer immediately (within the commissioning call itself) and relayed privately to the oracle process via a local file-based side-channel (`confidential-relay.ts`); the on-chain description carries `CONF_<ASSET>_<window>=<hash>`.

**Why $0.05, not Lepton's sub-$0.000001 nano-floor:** bonded signals require bond economics to make sense. At sub-cent prices the bond yield collapses below operator cost. Althemis prices at the lowest level where slashable honesty is economically viable — and composes naturally with downstream nano-tier consumers via Gateway batching.

**This is commit-hash confidentiality, not zero-knowledge.** The oracle process (and anyone with filesystem access to the VPS) can always see the raw value. What's hidden is from external third-party observers reading on-chain data only.

**Embargo model:** the raw value becomes public again at settlement (~8h later, same FR_WINDOW_MS as the rest of the protocol) via the existing event log — same mechanism financial markets use for earnings embargoes. The transparency guarantee (every terminal oracle decision is logged, verifiable, reproducible) is preserved: confidential jobs are temporarily hidden, never permanently opaque.

**What's real vs what's staged (Plan B, applied to the x402 layer):**

- **L1 (immutable):** open and confidential jobs run through the unmodified ERC8183/BondHook contract suite — same job lifecycle, same bond math, same slash path.
- **L2 (operator demo harness):** PCONF (provider) and PCONF_CONSUMER (buyer-side EOA) are two separately-funded wallets executing real on-chain transactions — createJob/fundJob signed by PCONF_CONSUMER, setBudget/submitSignal signed by PCONF — avoiding ERC8183's `client == provider` rejection (confirmed via `simulateContract`: the contract reverts on self-dealing with a dedicated custom error) and matching the same consumer/provider split already used by the autonomous CBUYER → PCHEAP path.
- **L3 (external participants):** **zero independent third parties, disclosed honestly** — but the full x402 payment loop has been exercised end-to-end using a real, independently-funded ephemeral buyer EOA (Circle Gateway deposit → `gateway.pay()` → 402 challenge resolved → settlement). Both commissioning types were exercised during development; the marketplace now runs confidential-type commissioning, and both settlement paths are verified on-chain:

  | Tier | Job ID | Settle amount | Submit tx |
  |---|---|---|---|
  | open | 899 | $0.01 | [`0xd0d2b206...`](https://testnet.arcscan.app/tx/0xd0d2b206d236b742ee1e9fd5c8e758898afd58b6482a5f78dcc3d2069c75e259) |
  | confidential | 911 | $0.05 | [`0x41d8cec6...`](https://testnet.arcscan.app/tx/0x41d8cec6667fa56ee9638fb7791e663221e3f70ef4c0d2680853caf5176d6b90) |

  Both submit transactions route through Arc's native [Transaction Memo contract](https://testnet.arcscan.app/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505) (`to == MEMO`), preserve `msg.sender` as the PCONF provider via `CallFrom`, and emit a `Memo` event with `memoId == jobId` — giving any external observer a deterministic on-chain index from commissioning payment to settled job. The buyer client used for this verification is a probe script, not a production-grade integration; what's verified is the payment-to-settlement path itself, not a polished buyer UX.

**Known scope limitation:** the confidential relay schema currently carries only `{value, nonce, asset, window}` — no `z`/`dir`. Confidential-tier jobs are attestation-verified (Phase A) like any other; the directional/conditional extension that would make confidentiality a product (sealed conditions, see the section intro) is the roadmap item, not a shipped claim.

</details>

<details>
<summary><b>Future Work: ZK / TEE / MPC alternatives to commit-hash confidentiality</b></summary>


A zero-knowledge range proof (prove `|value - median| <= threshold` without revealing `value`) would remove the "oracle operator can see it" caveat entirely — but circuit development is a week-plus undertaking, and on-chain verification gas cost would dwarf PCHEAP's sub-cent budget model. TEE/MPC approaches were also considered and rejected: they relocate trust to a hardware vendor or an N-of-M operator set, and Althemis currently runs a single oracle operator (N≥2 MPC requirements don't apply). Commit-hash confidentiality with a disclosed embargo window was chosen as the option deliverable within the hackathon timeframe, with the trust model stated plainly rather than obscured.

</details>

## Status

- ✅ **Sub-cent autonomous operation.** `PCHEAP` (the flagship honest provider) runs at a budget of `0.001 USDC` per job — the protocol's bond/settlement math holds at this scale, not just at round-number demo amounts.
- ✅ End-to-end slash flow verified on Arc Testnet: an honest attestation passes Phase A (Reliability +1), and a fabricated attestation is detected and SLASHED 100% of bond, resetting Reliability to zero.
- ✅ **The oracle slashes autonomously.** Phase A reaches its verdict from a 6-CEX median with a deterministic threshold and submits the on-chain `reject` itself — no external price oracle, no human in the slash path. The fabrication verdict is reproducible: the same CEX quorum and threshold yield the same outcome on replay.
- ✅ Live slash on Arc Testnet (BondHook `0xc522095eb7ddaa9b67ca735eebedc073370a5f5f`): a fabricated `FR_BTC_8h=0.005;z=99` was caught against a 6-CEX median of `~0` (`diff=5.0e-3` > threshold `1.07e-4`, quorum 6/6) and slashed: [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8). The provider's `verifiedCount` reset `1 -> 0`, returning the bond rate to the `20000` bps default.
- ✅ **Conditional contract layer deployed and wired.** `ConditionalPriceFeed` and `ConditionalEscrow` are live on Arc Testnet (addresses above), with 12 Foundry tests passing and the existing BondHook suite unchanged (43/43). The oracle discovers `Committed` jobs, posts realized values at the deadline, and settles permissionlessly; the provider side (`PCHEAP`) declares a condition from its FR signal whenever direction is non-neutral, and the dashboard renders the conditional ledger.
- ⏳ **First conditional settlement not yet captured, disclosed honestly.** The provider only declares a condition on a non-neutral FR direction (the same no-claim-on-neutral rule as the retired Phase B). The market has been in a neutral funding regime since deployment, so no conditional contract has committed yet — and we will not force-fire one against a live wallet to manufacture a screenshot. The mechanism is verified by its 12 on-chain-semantics tests and the live deployment; the first organic release/refund tx will appear on the dashboard when the market moves, and is not backfilled here.
- ✅ Automated pipeline under systemd: `althemis.service` (Council consumer cycle + Provider job submission + conditional declaration) and `althemis-oracle.service` (Phase A + conditional settlement) run unattended, with state persisted across restarts.
- ✅ `BondHook.sol` Foundry suite: 31 tests — bond lock/unlock/withdraw, `beforeFund` coverage + new-provider caps, two-axis bond rate (Reliability sets bps, retired Skill discount + 110% floor), 3-way slash distribution (consumer 100% / challenger 10% / treasury remainder) with event/balance assertions, and the non-slash reject path. `ConditionalEscrow.sol` suite: 12 tests — release/refund × GTE/LTE, feed-not-ready hold, signature & parameter-mismatch rejection, double-commit/settle guards, boundary inclusivity. Run with `forge test` (43/43).
- ✅ Live dashboard at [`althemis.a2aflow.space`](https://althemis.a2aflow.space), rendering the real roster (PCHEAP/PHONEST/PLIAR/PCONF), recent oracle events, and the conditional-contract ledger from a static `data.json` generated every 5 minutes by a systemd timer — no mock data.
- 🔜 Public Provider onboarding (external, non-operator participants).

## What's real vs what's staged

Althemis is a hackathon submission, and we hold ourselves to the same falsification discipline the protocol enforces on its Providers. Rather than dress up a single-operator demo as organic traction, we state plainly what is real, what is operator-driven, and what does not exist yet.

**Layer 1 — The protocol (real, immutable, independently verifiable).**
`BondHook.sol`, the Reliability tier engine, the 3-way slash distribution, the 110% floor, the autonomous Phase A oracle, and the `ConditionalEscrow`/`ConditionalPriceFeed` pair are all on-chain on Arc Testnet. Anyone can `cast call` the contracts, replay the 6-CEX quorum, or re-run `forge test` (43/43) against this repo. None of this can be faked or quietly edited — the slash logic that burns a fabricator's bond is the same code path whether the fabricator is the operator or a stranger.

**Layer 2 — The operator demonstration (real transactions, single operator playing a roster).**
The live agents that populate the market are run by the operator, but as a **roster of independent wallets with distinct, hard-coded honesty policies** — not a single self-dealing pair. The honest provider (`PCHEAP`) always reports the true 6-CEX signal; a deliberately dishonest provider (`PLIAR`) fabricates a fraction of the time. The full Reliability axis has been exercised end-to-end on-chain: a provider climbs **Bronze → Silver → Gold** purely by accumulating verified attestations, and a fabricated attestation is caught by the oracle and slashed autonomously, resetting that provider to Bronze. Crucially, this demonstration is **operator-adverse**: when `PLIAR` lies and gets slashed, it is the operator's own bond that burns. We are not staging wins — we are staging an honest distribution of outcomes, losses included, because that is the only thing the protocol actually claims to guarantee.

**Layer 3 — External participants (none yet — stated honestly).**
There are no independent third-party Providers or Consumers on the marketplace today. We do not simulate them, and the dashboard is built to make their absence un-hideable: job counts can be inflated by an operator, but the **unique-buyer count cannot be**, so both numbers are shown side by side. The marketplace contract is permissionless and ready for external onboarding; that adoption simply hasn't happened in a testnet hackathon window, and we would rather say so than fabricate a leaderboard — which would be, fittingly, the exact behavior Althemis slashes.

## Known Limitations & Roadmap

<details>
<summary><b>Deliberate design choices (not bugs)</b> — fabrication threshold floor, quorum fallback, conditional hold, regime bonding</summary>


- **Fabrication threshold = `max(3×MAD, 0.0001)`.** In low-volatility regimes MAD collapses toward zero, which would make a pure 3×MAD rule slash honest Providers whose aggregation method merely differs from the oracle's. The absolute floor guarantees that only unambiguous fabrication is punished — consistent with the core principle that punishment must stay deterministic. The floor is what makes the honest path survive: an attested FR a few parts in 1e-6 away from consensus sits far inside a floor-dominated threshold of `1e-4` and is VERIFIED, never slashed.
- **Quorum 4/6 with `unverifiable` fallback.** If fewer than 4 of 6 CEXs respond, the oracle retries; if the attestation freshness window (15 min) expires, the job settles COMPLETE with **no slash and no tier impact**. The protocol never punishes what it could not verify.
- **Conditional settlement holds, never defaults.** If the realized value has not been posted to `ConditionalPriceFeed` at the deadline (e.g. a transient CEX-quorum failure), `settle` reverts and the escrow is held — it never defaults to a release or a refund. A held escrow resolves on the next poll once the feed is posted. The protocol never pays out on data it does not have.
- **Regime signals carry no bond.** Regime classification is interpretive; it lives entirely in the reputation domain with the Adjudicator as backstop.

</details>

<details>
<summary><b>v1 scope cuts</b> — thin on-chain scope, conditional v1 minimalism, deferred OI verification, operator-run Adjudicator</summary>


- **On-chain scope is deliberately thin.** This repository's contracts are `BondHook.sol` (bond custody, the Reliability bond rate + 110% floor, the new-provider exposure cap, and slash execution) and the conditional pair (`ConditionalEscrow.sol` + `ConditionalPriceFeed.sol`). The job lifecycle (create / fund / submit / settle) lives in an external **ERC-8183** job marketplace core deployed on Arc Testnet; Althemis hangs off it as a hook rather than re-implementing a registry. Dependency details (core contract address, ABI notes) are in `protocol/escrow.ts`.
- **Conditional layer is v1-minimal: no fee, no bond, no challenger.** Settlement is deterministic and re-derivable from public data, so v1 takes no fee and runs no challenger on the conditional path. Fee economics, a feed-value challenge path (reusing the BondVault optimistic-challenge pattern), and shorter windows (1h, once a price feed backs them) are roadmap items. The selectable window is currently `{8,16,24}h`.
- **Interpretive-dispute filer reward (broad 60/20/20 split) is deferred.** The implemented slash is already 3-way — consumer 100% / challenger 10% / treasury remainder — and the challenger reward is live for *deterministic* permissionless challenges (expired squatters, post-expiry submits). What v2 adds is a filer reward for *interpretive* disputes, which only makes sense once dispute filing for non-deterministic claims is permissionless — that requires the v2 Adjudicator work below.
- **OI attestation verification is deferred.** Open interest lacks a clean cross-exchange consensus value (OI is venue-local, not fungible across exchanges the way funding rates are comparable). Rather than auto-passing OI attestations — which would dilute the meaning of "verified" — OI jobs are held out of Phase A until a sound verification source is defined.
- **Adjudicator is operator-run.** v1 uses a single operator-controlled Adjudicator, invoked only on attestation-fraud disputes. v2 roadmap: decentralize adjudication (committee or restaked-operator model), open dispute filing permissionlessly (50%-of-bond filer stake, 20% filer reward), and extend dispute scope beyond attestation fraud only where a deterministic verification rule exists for the new claim type.

</details>

### Roadmap

1. ✅ Foundry suites: `BondHook.sol` (31) + `ConditionalEscrow.sol` (12) — **done, 43 passing**
2. ✅ Conditional contract layer (deploy + oracle settlement + provider declaration + dashboard) — **done; first organic settlement pending a non-neutral market**
3. Confidential × conditional: sealed proprietary conditions (the pairing that makes confidentiality a product)
4. Conditional fee economics + feed-value challenge path + shorter windows
5. Public Provider onboarding (external, non-operator participants)
6. OI attestation verification source
7. Adjudicator decentralization + permissionless dispute filing with filer reward (v2)
8. Multi-asset signals beyond BTC

## Tech stack

- **Chain**: Arc Testnet (Circle), USDC-native. Job lifecycle runs on an external **ERC-8183** job marketplace core; the contracts in this repo are `BondHook.sol` (bond custody + slash execution) and the conditional pair (`ConditionalEscrow.sol` + `ConditionalPriceFeed.sol`), built with Foundry. Since existing ACP tooling doesn't target Arc, contract interaction is done directly with **viem**. (Note: the core's `getJob` returns a JSON-shaped tuple; its ABI is defined as a JSON fragment in `protocol/escrow.ts` rather than `parseAbi`.)
- **Protocol layer** (`protocol/` — escrow, oracle, tier, arc, conditional): **TypeScript** via `tsx` with `allowJs`, so it interoperates with the existing JS agent layer without a migration.
- **Agent layer** (`agents/`, `core/`): Node.js — Council debate, calibration, post-mortem modules reused from prior Triple-A systems.
- **Market data**: 6 CEX public endpoints (no API keys required), median ± MAD aggregation.
- **Payments / Circle**: Circle Gateway nanopayments via the **x402** batching SDK for confidential signal commissioning ($0.05, commit-hash on-chain); commissioning-to-settlement is indexed on-chain through Arc's native **Transaction Memo** contract (`memoId == jobId`).
- **State**: `data/tiers.json`, `data/job_state.json`, `data/oracle_state.json`, `data/conditional_state.json`. The oracle discovers work by scanning on-chain job status and persists confirmation windows, so it resumes across restarts without resetting timers.

## Design lineage

Althemis reuses battle-tested components from earlier agent systems by the same author: the **Triple-A Council** pattern (Architect / Auditor / Arbiter adversarial debate), calibration-driven confidence scoring, and a post-mortem feedback loop — here repurposed so that the marketplace's settlement layer is fully deterministic while interpretation stays in the LLM domain. The guiding split throughout: **bots for anything auditable, agents for anything that requires reading context.**

## Disclaimer

Testnet software, in active development. Nothing here is financial advice; signals traded on Althemis are inputs to autonomous agents, not recommendations to humans.

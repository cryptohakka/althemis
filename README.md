# Althemis

[![CI](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml)

**An A2A signal marketplace that slashes fabricated facts and settles forecasts as bonded conditional commitments — never grading either by opinion.**

> **TL;DR** — Agents sell market signals under USDC bonds on Arc Testnet. A fabricated **fact** gets the bond **slashed 100% on-chain, autonomously**, within minutes. A **forecast** is sold as a *bonded conditional commitment*: the Provider posts a **reserve** behind a verifiable threshold, a Consumer pays a **premium** to buy a claim on it, and at the deadline the realized value — read from public data — either returns the reserve to the Provider (condition **met**) or pays it out to the Consumer (condition **missed**), the Provider keeping the premium either way. No forecast is ever "graded" for skill. The honest autonomous loop runs at **0.001 USDC per job**. **A Provider can be wrong and survive; a Provider cannot lie and survive — a miss is a loss, not a lie, and it is settled, not slashed.**

Althemis (AI + Themis) is an agent-to-agent marketplace where autonomous **Providers** sell market signals (funding rate, open interest, regime) under USDC bonds, **Consumers** purchase and integrate them via a multi-agent Council, and an on-chain bond + price oracle settles outcomes — slashing fabricated data and settling forecasts as deterministic bonded conditional commitments, where a Provider posts a reserve and a Consumer buys a claim on it.

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

**[Demo Video](<URL>)** · **[Live Dashboard](https://althemis.a2aflow.space)** · **One-command repro:** `forge test` (50/50 passing: BondHook 31 + ConditionalEscrow 19)

**Proof:** autonomous slash on Arc Testnet — [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8)

**Falsification discipline:** we built a probabilistic skill-scorer, measured it against an external harness, and retired it — the signal came back `NO_EDGE` and the mechanism had no buyer. We kept the evidence rather than quietly deleting it. ([details](#how-we-falsified-our-own-product))

**Built with:** Arc Testnet · USDC · [Circle Gateway Nanopayments (x402)](#confidential-signal-commissioning-x402-arccircle-gateway) · Foundry · viem

---

## Core Principle

> **Punishment belongs to the deterministic domain. So does settlement. Skill-grading belongs to neither — so we removed it.**

Most "slashing for bad signals" designs conflate two different failures:

1. **Lying about facts** — reporting a funding rate no exchange printed. Verifiable *at issuance*, and it deserves hard, deterministic punishment.
2. **Being wrong about the future** — a prediction that didn't pan out. Markets are stochastic; punishing variance teaches Providers to stop making bold calls, not to be honest.

The first version of Althemis drew this line and then made a second, quieter claim: that an honest-but-wrong forecast should move a **probabilistic skill score**. We built that scorer, measured it, and retired it (see *How we falsified our own product*). What replaced it is not a better scorer — it is the deletion of scoring as a step. A forecast is now sold as a **bonded conditional commitment**: the Provider posts a reserve behind a measurable condition, a Consumer pays a premium to buy a claim on it, and the contract settles it deterministically against public data. Met → the reserve returns to the Provider, which also keeps the premium. Missed → the reserve pays out to the Consumer, the Provider still keeping the premium. The protocol verifies *the condition*, never *the quality of the inference*.

| Layer | What it claims | Verification | Consequence |
|---|---|---|---|
| **Attestation** | A fact at issuance ("BTC FR is X right now") | Immediate, vs 6-CEX median ± MAD | Fabrication → **100% bond slash**, within minutes |
| **Bonded conditional commitment** | A measurable future condition ("FR ≤ X within 8h") | At the deadline, vs the same public data | Met → **reserve returns** to Provider; missed → **reserve pays out** to Consumer. No slash, no score. |

A Provider can be wrong and survive — a missed condition simply pays its reserve out to the buyer, no slash, no score. A Provider cannot lie and survive — a fabricated input is slashed regardless of any condition. **Althemis bonds honesty, not alpha.**

The two failures settle on different clocks: a lie makes the Consumer whole fast (Phase A slashes within minutes, returning 100% of the price, no waiting for the forecast window); a missed forecast pays out on schedule (the commitment releases the reserve to the Consumer at the deadline — no slash, the Provider keeping only the premium it was paid). Different harms, different remedies: a lie is punished, a miss is covered.

**One principle ties the two layers together — input integrity.** A conditional contract is only meaningful if the facts it is built on were themselves verifiable. The condition is measured against the *same* attested, Phase-A-checked public data that the slash layer polices. A Provider cannot declare a condition over a fabricated feed: the fact layer is slashable, so the contract layer inherits its integrity.

## How we falsified our own product

Most reputation systems assume their own tiers mean something. We built ours, measured it against an external harness, and the thing we were measuring did not survive. This section is about what exactly failed — because it is narrower than "our predictions are worthless," and the distinction is the whole point.

### What we tested, and what we did not

The retired Phase B graded one signal: **frZ** — the BTC funding rate expressed as a z-score against its own rolling mean. Run through [touchstone](https://touchstone.a2aflow.space), our standalone falsification harness, frZ returns **`NO_EDGE`**: `min_p = 0.0897`, zero survivors after episode-collapse + HAC + M = 6 multiple-comparison correction. As a directional skill signal, frZ does not clear the bar — and `touchstone` is deliberately external to Althemis, so this is not us grading ourselves leniently.

This result is scoped to frZ. It is **not** a claim that funding-rate prediction is impossible, that no signal could ever have edge, or that predictive skill is a fiction. It is one signal, measured honestly, coming back null. We report the null rather than burying it — but we do not inflate it into a law.

### What actually failed was the mechanism, not just the signal

Even granting a hypothetical signal *with* edge, the Phase B scorer had problems independent of frZ's null result: its 20-job promotion window let a zero-edge Provider clear Silver roughly one window in four by chance alone, the point estimates it ranked on sat inside confidence intervals that straddled coin-flip, and its own Council selectivity gate — meant to catch exactly this — scored as **NOT_SELECTIVE** against an oracle positive control that scored **SELECTIVE**. The safety net that should have caught a non-signal didn't. And underneath all three: no Consumer was ever paying for a graded directional score in the first place.

So the thing we falsified is not "frZ has no edge" (one data point toward it) — it is **the Phase B mechanism itself: grading predictions as a saleable product.** A better signal would not have fixed the noisy window, the non-selective gate, or the absent buyer.

### What we did about it

We did not patch the scorer. We removed scoring as a step and replaced it with the conditional contract (see *What is sold*): a prediction settles against public fact, so the protocol never needs a skill estimate it cannot defend. The boundary that defines Althemis — punish fabricated facts, never punish wrong predictions — does **not** depend on this measurement. We would draw that line whether or not frZ had edge; the measurement is why we stopped *grading* predictions, not why we stopped *punishing* errors (we never did the latter). The two are separate, and we keep them separate on purpose.

### We kept the evidence

The retired scorer is not deleted. The `BondHook.sol` skill-discount logic and its tests remain in the repo, disabled at the product layer rather than ripped out — and the 110% bond floor is still derived from it (`MIN_BOND_RATE_BPS = 11000 = 13750 × 0.80`, the Gold × Edge-G corner that the discount could reach). We keep it as **forensic evidence**: the bar a Provider would have had to clear, the test that proves the floor came from a real discount schedule, and the harness output that says no Provider clears the bar. Deleting it would erase the very thing that makes the falsification checkable. Falsification discipline means showing the mechanism you retired, not just asserting you retired it.

## What is sold

Althemis sells two things, and is precise about which is which.

**A fact, under bond.** A Provider attests "BTC funding rate is X right now." This is checkable immediately against six public exchanges. If it's fabricated, the bond is slashed 100%, on-chain, autonomously, within minutes. This is the slash layer, and it is unchanged from day one.

**A condition, under bond.** A Provider declares "BTC funding rate will be ≤ X within 8 hours" and posts a **reserve** behind it. A Consumer pays a **premium** to buy a claim on that reserve. At the deadline, anyone can settle: the realized funding rate is read from `ConditionalPriceFeed` (the same 6-CEX median the slash layer uses), and `ConditionalEscrow` either returns the reserve to the Provider (condition met) or pays the reserve out to the Consumer (condition missed) — the Provider keeping the premium either way. This is settlement by public fact, not by judgement. Forecasts are sold as **bonded conditional commitments** — which is what lets "an honesty market, settled by public fact" be literally true rather than a slogan.

### Why a contract, not a score

The retired Phase B tried to *grade* forecasts — score directional calls, accumulate a win rate, discount the bond for "skilled" Providers. The bonded conditional commitment fixes structurally what that mechanism never could tune around: no skill signal to defend (ours didn't survive scrutiny, see above), no protocol opinion to be wrong about, and a missed condition pays the reserve out to the buyer instead of leaving it exposed — the buyer's downside is capped at the premium, by construction.

### What's deployed

Two contracts, independent of the BondHook/ERC-8183 suite (own bond escrow, no shared state):

| Contract | Address (Arc Testnet) | Role |
|---|---|---|
| `ConditionalPriceFeed` | [`0x1793c8c7…`](https://testnet.arcscan.app/address/0x1793c8c7c28ca1fa0a29af1f34973d9e23d9a88d) | Single-oracle, write-once realized-value feed (same 6-CEX trust model as Phase A) |
| `ConditionalEscrow` | [`0x8944f39f…`](https://testnet.arcscan.app/address/0x8944f39f37d4a6cba0c36bdfff74f4c911fd14a9) | `declare`(reserve) → `purchase`(premium) → permissionless `settle` → met: reserve returns / missed: reserve pays out |

**Self-dealing is structurally impossible, not policed.** The Provider signs only the *declaration* — `(asset, window, op, expected)` — never the settlement target or calldata. `ConditionalEscrow` builds the comparison itself from enumerable parameters (`asset ∈ {BTC}`, `window ∈ {8,16,24}h`, `op ∈ {GTE,LTE}`). A Provider cannot point the contract at a value of its choosing; it can only state a threshold and a direction. [19 Foundry tests](contracts/test/ConditionalEscrow.t.sol) cover met-release and missed-payout in both directions, the unpurchased-withdraw path, the feed-not-ready hold, signature/parameter-mismatch rejection, and boundary inclusivity; the existing BondHook suite is unchanged — **50/50 total**.

**v1 is intentionally minimal:** no protocol fee and no challenger on the conditional layer (the Provider still posts a reserve — that is the bond). Settlement is deterministic and re-derivable from public data, so a met-release or a missed-payout needs no dispute path. If the feed is not yet posted at the deadline, settlement **holds** — it never defaults to a payout. Fee economics and a feed-value challenge path are on the roadmap.

**Buyer-facing reputation: Fulfillment, not Skill.** A Provider's declared-condition fulfillment rate (met ÷ total settled) is a deterministic, public ratio — the honest successor to the retired skill score, for *display* only. It is never wired into the bond rate: bond economics depend on Reliability alone, so a Provider cannot buy a cheaper bond by making easy calls. This is the same trap the skill discount fell into, avoided structurally.

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
   Bonded conditional commitment layer (independent escrow)
        Provider declares (asset, window, op, expected)
                          │
                          ▼
        ConditionalEscrow ── declare → purchase → settle (permissionless)
                          │         provider posts reserve, consumer pays premium;
                          ▼         realized value from ConditionalPriceFeed (6-CEX)
              met: reserve returns / missed: reserve pays out
```

### Roles

- **Provider** — sells signals. Onboards in a single transaction (bond + registry). Posts a USDC bond whose required ratio depends on Reliability tier (see below). New Providers are capped at 1 USDC exposure for their first 10 jobs.
- **Consumer** — buys signals and integrates them through a Triple-A Council (Architect / Auditor / Arbiter debate) before acting. Payment = participation; no separate registration step.
- **Adjudicator** — operator-run in v1; invoked **only** on disputes, which are restricted to attestation fraud claims. Dispute filing in v1 goes through the operator; permissionless filing (with a filer bond equal to 50% of the Provider's bond, to deter spam) ships in v2 together with the filer reward.
- **Price Oracle** — Phase A, plus the conditional settlement loop. **Phase A (attestation)**: within 15 minutes of submission, verifies the attested value against the 6-CEX median ± MAD; the fabrication threshold is `max(3×MAD, 0.0001)`. Requires a 4-of-6 CEX quorum — below quorum it retries, and if the verification window expires the job is marked **unverifiable** and settles COMPLETE with no slash and no tier impact. **Conditional settlement**: it indexes `Declared` and `Purchased` jobs, posts the realized value to `ConditionalPriceFeed` at the deadline, and calls the permissionless `settle` (or `withdraw` for a commitment no buyer purchased). This loop is fault-isolated — an RPC failure in the conditional path can never crash Phase A.

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

**What this is, and what it is not yet.** The confidential tier below is a working **mechanism demonstration** of x402-commissioned, commit-hash-on-chain signal delivery — the full Circle Gateway payment loop, the embargo, and the on-chain Memo index all run end-to-end. What it is *not* yet is a product: hiding a *public* funding rate behind a commit-hash has little standalone value. Confidentiality earns its keep when paired with the **conditional contract** — hiding a Provider's *proprietary condition* (e.g. a large-execution threshold, or a bet from a private model) so it cannot be front-run or imitated before the deadline. Because a missed condition pays the reserve out to the buyer, a buyer can pay a premium for a sealed condition without first seeing it — the reserve, not the disclosed condition, is what backs the claim, which is what dissolves the information paradox that normally blocks selling un-inspectable forecasts. That pairing is on the roadmap; what's shipped today is the commissioning mechanism it will run on.

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

**What's verified on-chain** (same L1/L2/L3 honesty split as [What's real vs what's staged](#whats-real-vs-whats-staged)): PCONF and PCONF_CONSUMER are separately-funded wallets — avoiding ERC8183's `client == provider` self-dealing rejection — and the full x402 payment loop (Circle Gateway deposit → `gateway.pay()` → 402 challenge → settlement) has been exercised end-to-end with a real, independently-funded ephemeral buyer EOA. Both commissioning types are verified on-chain:

  | Tier | Job ID | Settle amount | Submit tx |
  |---|---|---|---|
  | open | 899 | $0.01 | [`0xd0d2b206...`](https://testnet.arcscan.app/tx/0xd0d2b206d236b742ee1e9fd5c8e758898afd58b6482a5f78dcc3d2069c75e259) |
  | confidential | 911 | $0.05 | [`0x41d8cec6...`](https://testnet.arcscan.app/tx/0x41d8cec6667fa56ee9638fb7791e663221e3f70ef4c0d2680853caf5176d6b90) |

  Both submit transactions route through Arc's native [Transaction Memo contract](https://testnet.arcscan.app/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505) (`to == MEMO`), preserve `msg.sender` as the PCONF provider via `CallFrom`, and emit a `Memo` event with `memoId == jobId` — giving any external observer a deterministic on-chain index from commissioning payment to settled job. The buyer client used for this verification is a probe script, not a production-grade integration; what's verified is the payment-to-settlement path itself, not a polished buyer UX.

**Known scope limitation:** the confidential relay schema currently carries only `{value, nonce, asset, window}` — no `z`/`dir`. Confidential-tier jobs are attestation-verified (Phase A) like any other; the directional/conditional extension that would make confidentiality a product (sealed conditions, see the section intro) is the roadmap item, not a shipped claim.

</details>

*ZK/TEE/MPC alternatives to commit-hash confidentiality are future work — circuit cost and trust relocation made commit-hash the right hackathon-scope choice; see [Known Limitations](#known-limitations--roadmap).*

## Status

- ✅ **Sub-cent autonomous operation.** `PCHEAP` (the flagship honest provider) runs at a budget of `0.001 USDC` per job — the protocol's bond/settlement math holds at this scale, not just at round-number demo amounts.
- ✅ End-to-end slash flow verified on Arc Testnet: an honest attestation passes Phase A (Reliability +1), and a fabricated attestation is detected and SLASHED 100% of bond, resetting Reliability to zero.
- ✅ **The oracle slashes autonomously.** Phase A reaches its verdict from a 6-CEX median with a deterministic threshold and submits the on-chain `reject` itself — no external price oracle, no human in the slash path. The fabrication verdict is reproducible: the same CEX quorum and threshold yield the same outcome on replay.
- ✅ Live slash on Arc Testnet (BondHook `0xc522095eb7ddaa9b67ca735eebedc073370a5f5f`): a fabricated `FR_BTC_8h=0.005;z=99` was caught against a 6-CEX median of `~0` (`diff=5.0e-3` > threshold `1.07e-4`, quorum 6/6) and slashed: [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8). The provider's `verifiedCount` reset `1 -> 0`, returning the bond rate to the `20000` bps default.
- ✅ **Conditional contract layer deployed and wired.** `ConditionalPriceFeed` and `ConditionalEscrow` are live on Arc Testnet (addresses above), with 19 Foundry tests passing and the existing BondHook suite unchanged (50/50). The oracle indexes `Declared`/`Purchased` jobs, posts realized values at the deadline, and settles (or withdraws unpurchased commitments) permissionlessly; the provider side (`PCHEAP`) posts a reserve behind a condition from its FR signal whenever direction is non-neutral, `CBUYER` buys the claim, and the dashboard renders the conditional ledger.
- ✅ **Conditional layer running organically, end-to-end.** PCHEAP autonomously posts a reserve behind a short condition (`FR ≤ X within 8h`); CBUYER purchases the claim; at the 8h deadline the realized FR is read from public data and `ConditionalEscrow` settles each commitment deterministically — reserve returned to the Provider on a met condition, paid out to the Consumer on a missed one, with the Provider keeping the premium either way. No operator action in the loop: the Provider declares and bonds, the market moves, the contract settles. <!-- ORGANIC_PROOF --> **Live proof (job `0x65c1f391…`):** Provider declared `BTC 8h funding < −0.0058% / −6.4% APR` (`LTE`) and posted a 0.05 USDC reserve; CBUYER bought the claim for a 0.005 USDC premium; at the 8h deadline the realized FR read from `ConditionalPriceFeed` was **+0.0049% (+5.4% APR)** — the condition **missed**, so the reserve paid out to the Consumer while the Provider kept the premium. [declare](https://testnet.arcscan.app/tx/0x36c6488919dd2d9d2d7210a63aa2b09de634f1052fb3f93c1ec4900961c1f1ba) · [settle](https://testnet.arcscan.app/tx/0x61178905e20e9a77a6c7bb31c0cba3d7aaa38b982905f24fcd8d616a3adf5a80). Six further commitments settled identically in the same funding window (all `paidout`).
- ✅ Automated pipeline under systemd: `althemis.service` (Council consumer cycle + Provider job submission + conditional declaration) and `althemis-oracle.service` (Phase A + conditional settlement) run unattended, with state persisted across restarts.
- ✅ `BondHook.sol` Foundry suite: 31 tests — bond lock/unlock/withdraw, `beforeFund` coverage + new-provider caps, two-axis bond rate (Reliability sets bps, retired Skill discount + 110% floor), 3-way slash distribution (consumer 100% / challenger 10% / treasury remainder) with event/balance assertions, and the non-slash reject path. `ConditionalEscrow.sol` suite: 19 tests — met-release/missed-payout × GTE/LTE, unpurchased-withdraw, feed-not-ready hold, signature & parameter-mismatch rejection, double-purchase/settle guards, boundary inclusivity. Run with `forge test` (50/50).
- ✅ Live dashboard at [`althemis.a2aflow.space`](https://althemis.a2aflow.space), rendering the real roster (PCHEAP/PHONEST/PLIAR/PCONF), recent oracle events, and the conditional-contract ledger from a static `data.json` generated every 5 minutes by a systemd timer — no mock data.
- 🔜 Public Provider onboarding (external, non-operator participants).

## What's real vs what's staged

Althemis is a hackathon submission, and we hold ourselves to the same falsification discipline the protocol enforces on its Providers. Rather than dress up a single-operator demo as organic traction, we state plainly what is real, what is operator-driven, and what does not exist yet.

**Layer 1 — The protocol (real, immutable, independently verifiable).**
`BondHook.sol`, the Reliability tier engine, the 3-way slash distribution, the 110% floor, the autonomous Phase A oracle, and the `ConditionalEscrow`/`ConditionalPriceFeed` pair are all on-chain on Arc Testnet. Anyone can `cast call` the contracts, replay the 6-CEX quorum, or re-run `forge test` (50/50) against this repo. None of this can be faked or quietly edited — the slash logic that burns a fabricator's bond is the same code path whether the fabricator is the operator or a stranger.

**Layer 2 — The operator demonstration (real transactions, single operator playing a roster).**
The live agents that populate the market are run by the operator, but as a **roster of independent wallets with distinct, hard-coded honesty policies** — not a single self-dealing pair. The honest provider (`PCHEAP`) always reports the true 6-CEX signal; a deliberately dishonest provider (`PLIAR`) fabricates a fraction of the time. The full Reliability axis has been exercised end-to-end on-chain: a provider climbs **Bronze → Silver → Gold** purely by accumulating verified attestations, and a fabricated attestation is caught by the oracle and slashed autonomously, resetting that provider to Bronze. Crucially, this demonstration is **operator-adverse**: when `PLIAR` lies and gets slashed, it is the operator's own bond that burns. We are not staging wins — we are staging an honest distribution of outcomes, losses included, because that is the only thing the protocol actually claims to guarantee.

**Layer 3 — External participants (none yet — stated honestly).**
There are no independent third-party Providers or Consumers on the marketplace today. We do not simulate them, and the dashboard is built to make their absence un-hideable: job counts can be inflated by an operator, but the **unique-buyer count cannot be**, so both numbers are shown side by side. The marketplace contract is permissionless and ready for external onboarding; that adoption simply hasn't happened in a testnet hackathon window, and we would rather say so than fabricate a leaderboard — which would be, fittingly, the exact behavior Althemis slashes.

## Known Limitations & Roadmap

<details>
<summary><b>Design choices & v1 scope cuts</b> — fabrication threshold floor, quorum fallback, conditional hold, regime bonding, thin on-chain scope, deferred OI/Adjudicator</summary>

**Deliberate, not bugs:**
- **Fabrication threshold = `max(3×MAD, 0.0001)`.** An absolute floor stops a collapsed MAD (low-volatility regimes) from slashing honest Providers over aggregation noise — only unambiguous fabrication is punished.
- **Quorum 4/6, `unverifiable` fallback.** Below quorum, or past the 15-min freshness window, the job settles COMPLETE with no slash and no tier impact. The protocol never punishes what it could not verify.
- **Conditional settlement holds, never defaults.** If `ConditionalPriceFeed` isn't posted at the deadline, `settle` reverts and the escrow holds — resolving on the next poll once the feed lands. Never pays out on data it doesn't have.
- **Regime signals carry no bond** — interpretive classification stays in the reputation domain, Adjudicator as backstop.

**v1 scope cuts:**
- **On-chain scope is thin by design.** This repo ships `BondHook.sol` and the conditional pair; job lifecycle (create/fund/submit/settle) lives in an external **ERC-8183** core that Althemis hooks into rather than re-implementing.
- **Conditional layer is v1-minimal:** no fee, no bond, no challenger — settlement is deterministic and re-derivable, so none are needed yet. Window is currently `{8,16,24}h`; shorter windows and a feed-value challenge path are roadmap.
- **Interpretive-dispute filer reward deferred.** The deterministic slash is already 3-way (consumer 100% / challenger 10% / treasury remainder); a broader filer reward for *interpretive* disputes needs the v2 Adjudicator work below.
- **OI attestation deferred** — no clean cross-exchange consensus value for OI yet, so OI jobs sit outside Phase A rather than auto-passing.
- **Adjudicator is operator-run in v1**, invoked only on attestation-fraud disputes. v2: decentralize, open permissionless filing (50%-of-bond stake, 20% reward), extend scope where a deterministic rule exists.

</details>

### Roadmap

1. ✅ Foundry suites: `BondHook.sol` (31) + `ConditionalEscrow.sol` (19) — **done, 50 passing**
2. ✅ Conditional contract layer (deploy + oracle settlement + provider declaration + dashboard) — **done; declare→purchase→settle running organically end-to-end**
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

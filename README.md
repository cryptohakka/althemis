# Althemis

[![CI](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml)

**An A2A signal marketplace with deterministic punishment and probabilistic reputation.**

Althemis (AI + Themis) is an agent-to-agent marketplace where autonomous **Providers** sell market signals (funding rate, open interest, regime) under USDC bonds, **Consumers** purchase and integrate them via a multi-agent Council, and an on-chain escrow + price oracle settles outcomes — slashing fabricated data and continuously re-rating predictive skill.

Runs live on **Arc Testnet** (Circle), settled in USDC.

---

## Core Principle

> **Punishment belongs to the deterministic domain. Reputation belongs to the probabilistic domain.**

Most "slashing for bad signals" designs conflate two very different failures:

1. **Lying about facts** — e.g. reporting a funding rate that no exchange ever printed. This is verifiable *at issuance time* and deserves hard, deterministic punishment.
2. **Being wrong about the future** — a prediction that didn't pan out. Markets are stochastic; punishing variance teaches Providers to stop making bold calls, not to be honest.

Althemis therefore splits every signal into two layers:

| Layer | What it claims | Verification | Consequence |
|---|---|---|---|
| **Attestation** | A fact at issuance (e.g. "BTC FR is X right now") | Immediate, against 6-CEX median ± MAD | Fabrication → **100% bond slash** |
| **Prediction** | A claim about the future (e.g. "FR will revert within 8h") | Oracle confirmation after N hours | **Tier (reputation) update only — no slash** |

A Provider can be wrong and survive. A Provider cannot lie and survive.

**Althemis insures honesty, not alpha.**

## Is the tier selective? We measured it.

Most reputation systems assume their own tiers mean something. We checked ours, found they didn't, and rebuilt them.

**The old window promoted noise.** v1.0 ranked Providers by win rate over a 20-job window, promoting at `win_rate >= 0.60`. Under a fair coin (true p = 0.5):

```
P(win_rate >= 0.60 | n = 20, p = 0.5) = P(X >= 12 | Binom(20, 0.5)) = 0.252
```

A Provider with zero edge clears the Silver bar in **one window out of four**. False promotion was not a tail event.

**The point estimate is not the edge.** A Provider sitting at 13/20 = 65% looks promotable, but its Wilson 95% interval is `[0.39, 0.78]` -- it straddles 0.50, so coin-flip cannot be rejected. Ranking on the point estimate ranks on sampling noise, and the promote-in-1 / demote-in-2 asymmetry let that noise ratchet upward.

**Our own signal fails the external check.** Run through [touchstone](https://touchstone.a2aflow.space), our falsification harness, the frZ funding-rate signal returns `NO_EDGE`: `min_p = 0.0897`, zero survivors after episode-collapse + HAC + M = 6 multiple-comparison correction. The Council gate that would filter it sits at the **14.8th percentile -> NOT_SELECTIVE**, against an oracle positive control at the **0th percentile -> SELECTIVE**. The gate we would rely on does not select.

**So we split the tier into two axes** (full spec under *Tier system* below). Reliability is deterministic, slashable, and carries the bond economics; Skill grants a discount only when the Wilson **lower bound** -- not a lucky point estimate -- clears the bar. Under frZ's measured `NO_EDGE`, no Provider reaches Edge, so the Skill discount is fully implemented and **currently unused**: the data does not justify promoting anyone, and the system reports exactly that.

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
        Price Oracle (N-hour confirmation, 6-CEX public data)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   Deterministic settlement      Two-axis tier engine
   (COMPLETE / SLASH)            (Reliability: bond rate / Skill: discount)
                          │
                          ▼
        Adjudicator (dispute path — attestation fraud only)
```

### Roles

- **Provider** — sells signals. Onboards in a single transaction (bond + registry). Posts a USDC bond whose required ratio depends on tier (see below). New Providers are capped at 1 USDC exposure for their first 10 jobs.
- **Consumer** — buys signals and integrates them through a Triple-A Council (Architect / Auditor / Arbiter debate) before acting. Payment = participation; no separate registration step.
- **Adjudicator** — operator-run in v1; invoked **only** on disputes, which are restricted to attestation fraud claims. Dispute filing in v1 goes through the operator; permissionless filing (with a filer bond equal to 50% of the Provider's bond, to deter spam) ships in v2 together with the filer reward.
- **Price Oracle** — two-phase. **Phase A (attestation)**: within 15 minutes of submission, verifies the attested value against the 6-CEX median ± MAD; the fabrication threshold is `max(3×MAD, 0.0001)`. Requires a 4-of-6 CEX quorum — below quorum it retries, and if the verification window expires the job is marked **unverifiable** and settles COMPLETE with no slash and no tier impact. **Phase B (prediction)**: after the signal-type window (e.g. 8h for FR), scores directional correctness against confirmed funding data and updates tiers. Neutral signals and results inside the no-contest band are not scored.

### Signal types & settlement rules

| Signal | Confirmation window | No-contest band | Bond |
|---|---|---|---|
| **Funding Rate (FR)** | 8h | ±0.5×MAD (too close to call → does not consume a tier-window slot) | Yes |
| **Open Interest (OI)** | 4h | ±0.3% | Yes — **attestation verification deferred in v1** (see Limitations) |
| **Regime** | Rule-based settlement: volatility percentile 70/30 + 8h trend | — | **No bond** (Adjudicator-reviewed) |

Regime classification is inherently interpretive, so it carries no bond and no automated slash — it lives entirely in the reputation domain, with the Adjudicator as backstop.

### Tier system (reputation)

The tier was redesigned in v1.1 after we measured that the original win-rate window did not actually distinguish skill from noise (see *Is the tier selective?* above). Tiers now sit on **two independent axes**.

**Reliability axis — deterministic, sets the bond rate.** Driven by the Phase A *verified attestation count*. It is slashable: a proven fabrication resets the count to zero.

| Reliability | Verified count | Bond rate |
|---|---|---|
| Bronze | 0–9 | 20000 bps (200%) |
| Silver | 10–49 | 16000 bps (160%) |
| Gold | 50+ | 12500 bps (125%) |

**Skill axis — probabilistic, grants a discount only.** Driven by the **cumulative Wilson 95% lower bound** of directional win rate, not the point estimate. Demotion uses a 5% hysteresis band.

| Skill | Wilson lower bound | Effect |
|---|---|---|
| Unrated | n < 20 | none |
| Calibrated | lcb < 0.50 | none |
| Edge-S | lcb ≥ 0.50 | −10% |
| Edge-G | lcb ≥ 0.60 | −20% |

**Effective bond rate** = `reliabilityBps × skillDiscount / 10000`, with a hard floor of **10000 bps (100%)** enforced in `BondHook.sol`. The floor is the Gold × Edge-G corner (`12500 × 0.80 = 10000`): even the best-rated Provider still bonds 100% of exposure, so a slash always covers the consumer budget. Tier changes apply to **new job locks only** — an existing lock keeps the rate it was funded at.

Why the split: a fabrication is a deterministic fact, so it drives the slashable Reliability axis. Predictive skill is a statistical estimate, so it only ever grants a discount, and only when the *lower bound* — not a lucky point estimate — clears the bar. Punishment stays deterministic; reputation stays probabilistic.

### Slash distribution

When an attestation is proven fabricated, the slashed bond is split **80% to the harmed Consumer(s), 20% to the protocol treasury** (as implemented in `BondHook.sol`).

A 20% **dispute-filer reward** (target split: 60/20/20) is deliberately deferred to v2: in v1 the Adjudicator is operator-run and disputes are not permissionless, so a filer reward would have no functioning recipient role. It ships together with permissionless dispute filing — see Known Limitations & Roadmap.

## Status

- ✅ End-to-end flow verified on Arc Testnet under the two-axis tier system: an honest attestation passes Phase A (Reliability +1), and a fabricated attestation is detected and SLASHED 100% of bond, resetting Reliability to zero.
- ✅ **The oracle slashes autonomously.** Phase A reaches its verdict from a 6-CEX median with a deterministic threshold and submits the on-chain `reject` itself -- no external price oracle, no human in the slash path. The fabrication verdict is reproducible: the same CEX quorum and threshold yield the same outcome on replay.
- ✅ Live slash on Arc Testnet (BondHook `0xc522095eb7ddaa9b67ca735eebedc073370a5f5f`): a fabricated `FR_BTC_8h=0.005;z=99` was caught against a 6-CEX median of `~0` (`diff=5.0e-3` > threshold `1.07e-4`, quorum 6/6) and slashed: [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8). The provider's `verifiedCount` reset `1 -> 0`, returning the bond rate to the `20000` bps default.
- ✅ Automated pipeline under systemd: `althemis.service` (Council consumer cycle + Provider job submission) and `althemis-oracle.service` (two-phase settlement) run unattended, with oracle state persisted across restarts.
- ✅ The honest path and the `unverifiable` quorum-failure path (settles COMPLETE, no slash, no tier impact) are both exercised end-to-end and covered by the Foundry suite below.

  This is the core demonstration: under one deterministic threshold, an honest value survives and a fabricated value is slashed 100% of bond -- and the oracle does it on its own. *A Provider can be wrong and survive; a Provider cannot lie and survive.*
- ✅ `BondHook.sol` Foundry test suite: 26 tests passing — bond lock/unlock/withdraw, `beforeFund` coverage + new-provider caps, two-axis bond rate (Reliability sets bps, Skill discounts, 100% floor), slash 80/20 split with event/balance assertions, and the non-slash reject path (unverifiable settlement). Run with `forge test --match-path "contracts/test/BondHook.t.sol"`.
- 🔜 Public Provider onboarding, dashboard at `althemis.a2aflow.space`.

## Known Limitations & Roadmap

### Deliberate design choices (not bugs)

- **Fabrication threshold = `max(3×MAD, 0.0001)`.** In low-volatility regimes MAD collapses toward zero, which would make a pure 3×MAD rule slash honest Providers whose aggregation method merely differs from the oracle's. The absolute floor guarantees that only unambiguous fabrication is punished — consistent with the core principle that punishment must stay deterministic. The floor is what makes the honest path survive: an attested FR a few parts in 1e-6 away from consensus sits far inside a floor-dominated threshold of `1e-4` and is VERIFIED, never slashed.
- **Quorum 4/6 with `unverifiable` fallback.** If fewer than 4 of 6 CEXs respond, the oracle retries; if the attestation freshness window (15 min) expires, the job settles COMPLETE with **no slash and no tier impact**. The protocol never punishes what it could not verify.
- **No-contest band (±0.5×MAD) does not consume a tier-window slot.** A Provider who hugs the median earns no reputation from it — and because no-contest jobs are excluded from the 20-job window denominator entirely — enforced at the oracle call site, where only `win`/`loss` reach [`recordOutcome`](https://github.com/cryptohakka/althemis/blob/02ae413b9f933703c40a89152e426f574115fe12/protocol/oracle.ts#L409-L412), and at the type level, where [`JobOutcome = 'win' | 'loss'`](https://github.com/cryptohakka/althemis/blob/02ae413b9f933703c40a89152e426f574115fe12/protocol/tier.ts#L25) makes a no-contest structurally unrepresentable in the window — a Provider cannot graduate to Silver/Gold on neutral signals alone. This closes the band-hugging strategy where a Provider farms tier accuracy by submitting values indistinguishable from consensus: such submissions are reputation-neutral, not reputation-positive.
- **Regime signals carry no bond.** Regime classification is interpretive; it lives entirely in the reputation domain with the Adjudicator as backstop.

### v1 scope cuts

- **On-chain scope is deliberately thin.** This repository's only contract is `BondHook.sol` — bond custody, the two-axis bond rate (Reliability sets the bps, Skill discounts, 100% floor), the new-provider exposure cap, and slash execution. The job lifecycle (create / fund / submit / settle) lives in an external **ERC-8183** job marketplace core deployed on Arc Testnet; Althemis hangs off it as a hook rather than re-implementing a registry. Dependency details (core contract address, ABI notes) are in `protocol/escrow.ts`.
- **Dispute-filer reward (60/20/20 split) is deferred.** The implemented split is 80/20 (Consumer/treasury). The filer reward only makes sense once dispute filing is permissionless, which requires the v2 Adjudicator work below — shipping the reward before the role exists would be dead code in the critical slash path.
- **OI attestation verification is deferred.** Open interest lacks a clean cross-exchange consensus value (OI is venue-local, not fungible across exchanges the way funding rates are comparable). Rather than auto-passing OI attestations — which would dilute the meaning of "verified" — OI jobs are held out of Phase A until a sound verification source is defined.
- **Adjudicator is operator-run.** v1 uses a single operator-controlled Adjudicator, invoked only on attestation-fraud disputes. v2 roadmap: decentralize adjudication (committee or restaked-operator model), open dispute filing permissionlessly (50%-of-bond filer stake, 20% filer reward), and extend dispute scope beyond attestation fraud only where a deterministic verification rule exists for the new claim type.

### Roadmap

1. ✅ Foundry test suite for `BondHook.sol` (bond lock/unlock, slash + split, two-axis bond rate + 100% floor, new-provider cap) — **done, 26 tests passing**
2. Public Provider onboarding + dashboard (`althemis.a2aflow.space`)
3. OI attestation verification source
4. Adjudicator decentralization + permissionless dispute filing with filer reward (v2)
5. Multi-asset signals beyond BTC

## Tech stack

- **Chain**: Arc Testnet (Circle), USDC-native. Job lifecycle runs on an external **ERC-8183** job marketplace core; the only contract in this repo is `BondHook.sol` (bond custody + slash execution), built with Foundry. Since existing ACP tooling doesn't target Arc, contract interaction is done directly with **viem**. (Note: the core's `getJob` returns a JSON-shaped tuple; its ABI is defined as a JSON fragment in `protocol/escrow.ts` rather than `parseAbi`.)
- **Protocol layer** (`protocol/` — escrow, oracle, tier, arc): **TypeScript** via `tsx` with `allowJs`, so it interoperates with the existing JS agent layer without a migration.
- **Agent layer** (`agents/`, `core/`): Node.js — Council debate, calibration, post-mortem modules reused from prior Triple-A systems.
- **Market data**: 6 CEX public endpoints (no API keys required), median ± MAD aggregation.
- **State**: `data/tiers.json`, `data/job_state.json`, `data/oracle_state.json`. The oracle discovers work by scanning on-chain job status and persists confirmation windows, so it resumes across restarts without resetting timers.

## Design lineage

Althemis reuses battle-tested components from earlier agent systems by the same author: the **Triple-A Council** pattern (Architect / Auditor / Arbiter adversarial debate), calibration-driven confidence scoring, and a post-mortem feedback loop — here repurposed so that the marketplace's settlement layer is fully deterministic while interpretation stays in the LLM domain. The guiding split throughout: **bots for anything auditable, agents for anything that requires reading context.**

## Disclaimer

Testnet software, in active development. Nothing here is financial advice; signals traded on Althemis are inputs to autonomous agents, not recommendations to humans.

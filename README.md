# Althemis

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

## Architecture

```
Provider (FR / OI / Regime)          Consumer (Council)
   │  signal + USDC bond                │  pays → instant participation
   │                                    │
   ▼                                    ▼
        ERC-8004 registry + on-chain escrow (Arc Testnet, USDC)
                          │
                          ▼
        Price Oracle (N-hour confirmation, 6-CEX public data)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   Deterministic settlement      Tier engine (Bronze / Silver / Gold)
   (COMPLETE / SLASH)            (rolling 20-job tumbling window)
                          │
                          ▼
        Adjudicator (dispute path — attestation fraud only)
```

### Roles

- **Provider** — sells signals. Onboards in a single transaction (bond + registry). Posts a USDC bond whose required ratio depends on tier (see below). New Providers are capped at 1 USDC exposure for their first 10 jobs.
- **Consumer** — buys signals and integrates them through a Triple-A Council (Architect / Auditor / Arbiter debate) before acting. Payment = participation; no separate registration step.
- **Adjudicator** — operator-run in v1; invoked **only** on disputes, which are restricted to attestation fraud claims. Dispute filing requires a bond equal to 50% of the Provider's bond, to deter spam.
- **Price Oracle** — two-phase. **Phase A (attestation)**: within 15 minutes of submission, verifies the attested value against the 6-CEX median ± MAD; the fabrication threshold is `max(3×MAD, 0.0001)`. Requires a 4-of-6 CEX quorum — below quorum it retries, and if the verification window expires the job is marked **unverifiable** and settles COMPLETE with no slash and no tier impact. **Phase B (prediction)**: after the signal-type window (e.g. 8h for FR), scores directional correctness against confirmed funding data and updates tiers. Neutral signals and results inside the no-contest band are not scored.

### Signal types & settlement rules

| Signal | Confirmation window | No-contest band | Bond |
|---|---|---|---|
| **Funding Rate (FR)** | 8h | ±0.5×MAD (too close to call → does not consume a tier-window slot) | Yes |
| **Open Interest (OI)** | 4h | ±0.3% | Yes — **attestation verification deferred in v1** (see Limitations) |
| **Regime** | Rule-based settlement: volatility percentile 70/30 + 8h trend | — | **No bond** (Adjudicator-reviewed) |

Regime classification is inherently interpretive, so it carries no bond and no automated slash — it lives entirely in the reputation domain, with the Adjudicator as backstop.

### Tier system (reputation)

- **Window**: tumbling window of 20 settled jobs (not rolling — each window is evaluated once, preventing one bad streak from being double-counted).
- **Promotion**: 60% accuracy → Silver, 72% → Gold.
- **Demotion**: two consecutive windows at −5% below threshold.
- **What tier buys you**: required bond ratio of **200% (Bronze) / 150% (Silver) / 100% (Gold)** of signal exposure, plus marketplace display priority. Reputation literally lowers your cost of capital.

### Slash distribution

When an attestation is proven fabricated: **60%** to the harmed Consumer(s), **20%** to the dispute filer, **20%** to the protocol treasury.

## Status

- ✅ End-to-end flow verified on Arc Testnet: honest job settled COMPLETE; fabricated-data job detected and SLASHED.
- ✅ Two-phase oracle live: attestation VERIFIED in production (job #5, `medianAtAttest` / `madAtAttest` recorded on disk), and the `unverifiable` quorum-failure path exercised end-to-end (job #4 — settles COMPLETE with no slash, no tier impact).
- ✅ Automated pipeline under systemd: `althemis.service` (Council consumer cycle + Provider job submission) and `althemis-oracle.service` (two-phase settlement) run unattended, with oracle state persisted across restarts.
- 🔜 Public Provider onboarding, dashboard at `althemis.a2aflow.space`.

## Known Limitations & Roadmap

### Deliberate design choices (not bugs)

- **Fabrication threshold = `max(3×MAD, 0.0001)`.** In low-volatility regimes MAD collapses toward zero, which would make a pure 3×MAD rule slash honest Providers whose aggregation method merely differs from the oracle's. The absolute floor guarantees that only unambiguous fabrication is punished — consistent with the core principle that punishment must stay deterministic. Live example: job #5 attested FR `6.51e-6` against an oracle median of `1.47e-5`; a deviation of `8.2e-6` against a floor-dominated threshold of `1e-4` → VERIFIED.
- **Quorum 4/6 with `unverifiable` fallback.** If fewer than 4 of 6 CEXs respond, the oracle retries; if the attestation freshness window (15 min) expires, the job settles COMPLETE with **no slash and no tier impact**. The protocol never punishes what it could not verify. Live example: job #4.
- **No-contest band (±0.5×MAD) does not consume a tier-window slot.** A Provider who hugs the median earns no reputation from it — this closes the band-hugging strategy where a Provider farms tier accuracy by submitting values indistinguishable from consensus.
- **Regime signals carry no bond.** Regime classification is interpretive; it lives entirely in the reputation domain with the Adjudicator as backstop.

### v1 scope cuts

- **OI attestation verification is deferred.** Open interest lacks a clean cross-exchange consensus value (OI is venue-local, not fungible across exchanges the way funding rates are comparable). Rather than auto-passing OI attestations — which would dilute the meaning of "verified" — OI jobs are held out of Phase A until a sound verification source is defined.
- **Adjudicator is operator-run.** v1 uses a single operator-controlled Adjudicator, invoked only on attestation-fraud disputes. v2 roadmap: decentralize adjudication (committee or restaked-operator model), and extend dispute scope beyond attestation fraud only where a deterministic verification rule exists for the new claim type.

### Roadmap

1. Public Provider onboarding + dashboard (`althemis.a2aflow.space`)
2. OI attestation verification source
3. Adjudicator decentralization (v2)
4. Multi-asset signals beyond BTC

## Tech stack

- **Chain**: Arc Testnet (Circle), USDC-native. Job lifecycle via an ERC-8004-style job/registry contract; since existing ACP tooling doesn't target Arc, contract interaction is done directly with **viem**. (Note: `getJob` returns a JSON-shaped tuple; the ABI for it is defined as a JSON fragment in `protocol/escrow.ts` rather than `parseAbi`.)
- **Protocol layer** (`protocol/` — escrow, oracle, tier, arc): **TypeScript** via `tsx` with `allowJs`, so it interoperates with the existing JS agent layer without a migration.
- **Agent layer** (`agents/`, `core/`): Node.js — Council debate, calibration, post-mortem modules reused from prior Triple-A systems.
- **Market data**: 6 CEX public endpoints (no API keys required), median ± MAD aggregation.
- **State**: `data/tiers.json`, `data/job_state.json`, `data/oracle_state.json` (oracle confirmation windows survive process restarts without resetting).

## Design lineage

Althemis reuses battle-tested components from earlier agent systems by the same author: the **Triple-A Council** pattern (Architect / Auditor / Arbiter adversarial debate), calibration-driven confidence scoring, and a post-mortem feedback loop — here repurposed so that the marketplace's settlement layer is fully deterministic while interpretation stays in the LLM domain. The guiding split throughout: **bots for anything auditable, agents for anything that requires reading context.**

## Disclaimer

Testnet software, in active development. Nothing here is financial advice; signals traded on Althemis are inputs to autonomous agents, not recommendations to humans.

# Althemis

[![CI](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptohakka/althemis/actions/workflows/ci.yml)

**An A2A signal marketplace with deterministic punishment and probabilistic reputation.**

Althemis (AI + Themis) is an agent-to-agent marketplace where autonomous **Providers** sell market signals (funding rate, open interest, regime) under USDC bonds, **Consumers** purchase and integrate them via a multi-agent Council, and an on-chain escrow + price oracle settles outcomes — slashing fabricated data and continuously re-rating predictive skill.

Runs live on **Arc Testnet** (Circle), settled in USDC.

**RFB03 / Prior Art:** Existing agent-marketplace reputation systems (Assay
Protocol, Virtuals ACP, Olas) score outcomes on a single axis, conflating a
fabricated fact with an honest wrong guess. Althemis is built for the
distinction the category has not made: a deterministic lie-axis (slashable)
separated from a probabilistic error-axis (reputation-only) — enforced by
falsification discipline against our own signal, not just our competitors'.

**[Demo Video](TODO: 3-min demo video link)** · **[Live Dashboard](TODO: live link)** · **One-command repro:** `forge test --match-path "contracts/test/BondHook.t.sol"` (31/31 passing)

**Proof:** autonomous slash on Arc Testnet — [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8)

**Built with:** Arc Testnet · USDC · Circle Gateway Nanopayments (x402) · Foundry · viem

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

**Our own signal fails the external check.** Run through [touchstone](https://touchstone.a2aflow.space), our falsification harness, the frZ signal (funding rate, expressed as a z-score against its own rolling mean) returns `NO_EDGE`: `min_p = 0.0897`, zero survivors after episode-collapse + HAC + M = 6 multiple-comparison correction. The Council gate that would filter it sits at the **14.8th percentile -> NOT_SELECTIVE**, against an oracle positive control at the **0th percentile -> SELECTIVE**. The gate we would rely on does not select.

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
| Silver | 10–49 | 16500 bps (165%) |
| Gold | 50+ | 13750 bps (137.5%) |

**Skill axis — probabilistic, grants a discount only.** Driven by the **cumulative Wilson 95% lower bound** of directional win rate, not the point estimate. Demotion uses a 5% hysteresis band.

| Skill | Wilson lower bound | Effect |
|---|---|---|
| Unrated | n < 20 | none |
| Calibrated | lcb < 0.50 | none |
| Edge-S | lcb ≥ 0.50 | −10% |
| Edge-G | lcb ≥ 0.60 | −20% |

**Effective bond rate** = `reliabilityBps × skillDiscount / 10000`, with a hard floor of **11000 bps (110%)** enforced in `BondHook.sol`. The floor is the Gold × Edge-G corner (`13750 × 0.80 = 11000`): even the best-rated Provider still bonds 110% of exposure (100% to cover the consumer budget + 10% for a challenger reward), so a slash always covers the consumer budget. Tier changes apply to **new job locks only** — an existing lock keeps the rate it was funded at.

Why the split: a fabrication is a deterministic fact, so it drives the slashable Reliability axis. Predictive skill is a statistical estimate, so it only ever grants a discount, and only when the *lower bound* — not a lucky point estimate — clears the bar. Punishment stays deterministic; reputation stays probabilistic.

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
deterministic punishment, probabilistic reputation — only holds if the
*judgment* layer (was this signal worth acting on?) stays separate from the
*verification* layer (was this signal honest?). Wiring Council's verdict into
settlement would reintroduce exactly the conflation Althemis is built to avoid:
an LLM's contextual judgment call would start to influence a slash decision
that must remain reproducible and deterministic.

## Status

- ✅ **Sub-cent autonomous operation.** `PCHEAP` (the flagship honest provider) runs at a budget of `0.001 USDC` per job — the protocol's bond/settlement math holds at this scale, not just at round-number demo amounts.
- ✅ End-to-end flow verified on Arc Testnet under the two-axis tier system: an honest attestation passes Phase A (Reliability +1), and a fabricated attestation is detected and SLASHED 100% of bond, resetting Reliability to zero.
- ✅ **The oracle slashes autonomously.** Phase A reaches its verdict from a 6-CEX median with a deterministic threshold and submits the on-chain `reject` itself -- no external price oracle, no human in the slash path. The fabrication verdict is reproducible: the same CEX quorum and threshold yield the same outcome on replay.
- ✅ Live slash on Arc Testnet (BondHook `0xc522095eb7ddaa9b67ca735eebedc073370a5f5f`): a fabricated `FR_BTC_8h=0.005;z=99` was caught against a 6-CEX median of `~0` (`diff=5.0e-3` > threshold `1.07e-4`, quorum 6/6) and slashed: [`0x021e0422...`](https://testnet.arcscan.app/tx/0x021e0422d5752137eabdf3c1d0d90d93cfb71856216790230bdeb2c8cd44a8a8). The provider's `verifiedCount` reset `1 -> 0`, returning the bond rate to the `20000` bps default.
- ✅ Automated pipeline under systemd: `althemis.service` (Council consumer cycle + Provider job submission) and `althemis-oracle.service` (two-phase settlement) run unattended, with oracle state persisted across restarts.
- ✅ The honest path and the `unverifiable` quorum-failure path (settles COMPLETE, no slash, no tier impact) are both exercised end-to-end and covered by the Foundry suite below.

  This is the core demonstration: under one deterministic threshold, an honest value survives and a fabricated value is slashed 100% of bond -- and the oracle does it on its own. *A Provider can be wrong and survive; a Provider cannot lie and survive.*
- ✅ `BondHook.sol` Foundry test suite: 31 tests passing — bond lock/unlock/withdraw, `beforeFund` coverage + new-provider caps, two-axis bond rate (Reliability sets bps, Skill discounts, 110% floor), 3-way slash distribution (consumer 100% / challenger 10% / treasury remainder) with event/balance assertions, and the non-slash reject path (unverifiable settlement). Run with `forge test --match-path "contracts/test/BondHook.t.sol"`.
- 🔜 Public Provider onboarding, dashboard at `althemis.a2aflow.space`.

## What's real vs what's staged

Althemis is a hackathon submission, and we hold ourselves to the same falsification discipline the protocol enforces on its Providers. Rather than dress up a single-operator demo as organic traction, we state plainly what is real, what is operator-driven, and what does not exist yet.

**Layer 1 — The protocol (real, immutable, independently verifiable).**
`BondHook.sol`, the two-axis tier engine, the 3-way slash distribution, the 110% floor, and the autonomous Phase A oracle are all on-chain on Arc Testnet. Anyone can `cast call` the contract, replay the 6-CEX quorum, or re-run `forge test` (31/31) against this repo. None of this can be faked or quietly edited — the slash logic that burns a fabricator's bond is the same code path whether the fabricator is the operator or a stranger.

**Layer 2 — The operator demonstration (real transactions, single operator playing a roster).**
The live agents that populate the market are run by the operator, but as a **roster of independent wallets with distinct, hard-coded honesty policies** — not a single self-dealing pair. The honest provider (`PCHEAP`) always reports the true 6-CEX signal; a deliberately dishonest provider (`PLIAR`) fabricates a fraction of the time. The full Reliability axis has been exercised end-to-end on-chain: a provider climbs **Bronze → Silver → Gold** purely by accumulating verified attestations, and a fabricated attestation is caught by the oracle and slashed autonomously, resetting that provider to Bronze. Crucially, this demonstration is **operator-adverse**: when `PLIAR` lies and gets slashed, it is the operator's own bond that burns. We are not staging wins — we are staging an honest distribution of outcomes, losses included, because that is the only thing the protocol actually claims to guarantee.

**Layer 3 — External participants (none yet — stated honestly).**
There are no independent third-party Providers or Consumers on the marketplace today. We do not simulate them, and the dashboard is built to make their absence un-hideable: job counts can be inflated by an operator, but the **unique-buyer count cannot be**, so both numbers are shown side by side. The marketplace contract is permissionless and ready for external onboarding; that adoption simply hasn't happened in a testnet hackathon window, and we would rather say so than fabricate a leaderboard — which would be, fittingly, the exact behavior Althemis slashes.

## Known Limitations & Roadmap

### Deliberate design choices (not bugs)

- **Fabrication threshold = `max(3×MAD, 0.0001)`.** In low-volatility regimes MAD collapses toward zero, which would make a pure 3×MAD rule slash honest Providers whose aggregation method merely differs from the oracle's. The absolute floor guarantees that only unambiguous fabrication is punished — consistent with the core principle that punishment must stay deterministic. The floor is what makes the honest path survive: an attested FR a few parts in 1e-6 away from consensus sits far inside a floor-dominated threshold of `1e-4` and is VERIFIED, never slashed.
- **Quorum 4/6 with `unverifiable` fallback.** If fewer than 4 of 6 CEXs respond, the oracle retries; if the attestation freshness window (15 min) expires, the job settles COMPLETE with **no slash and no tier impact**. The protocol never punishes what it could not verify.
- **No-contest band (±0.5×MAD) does not consume a tier-window slot.** A Provider who hugs the median earns no reputation from it — and because no-contest jobs are excluded from the 20-job window denominator entirely — enforced at the oracle call site, where only `win`/`loss` reach [`recordOutcome`](https://github.com/cryptohakka/althemis/blob/02ae413b9f933703c40a89152e426f574115fe12/protocol/oracle.ts#L409-L412), and at the type level, where [`JobOutcome = 'win' | 'loss'`](https://github.com/cryptohakka/althemis/blob/02ae413b9f933703c40a89152e426f574115fe12/protocol/tier.ts#L25) makes a no-contest structurally unrepresentable in the window — a Provider cannot graduate to Silver/Gold on neutral signals alone. This closes the band-hugging strategy where a Provider farms tier accuracy by submitting values indistinguishable from consensus: such submissions are reputation-neutral, not reputation-positive.
- **Regime signals carry no bond.** Regime classification is interpretive; it lives entirely in the reputation domain with the Adjudicator as backstop.

### v1 scope cuts

- **On-chain scope is deliberately thin.** This repository's only contract is `BondHook.sol` — bond custody, the two-axis bond rate (Reliability sets the bps, Skill discounts, 110% floor), the new-provider exposure cap, and slash execution. The job lifecycle (create / fund / submit / settle) lives in an external **ERC-8183** job marketplace core deployed on Arc Testnet; Althemis hangs off it as a hook rather than re-implementing a registry. Dependency details (core contract address, ABI notes) are in `protocol/escrow.ts`.
- **Interpretive-dispute filer reward (broad 60/20/20 split) is deferred.** The implemented slash is already 3-way — consumer 100% / challenger 10% / treasury remainder — and the challenger reward is live for *deterministic* permissionless challenges (expired squatters, post-expiry submits). What v2 adds is a filer reward for *interpretive* disputes, which only makes sense once dispute filing for non-deterministic claims is permissionless — that requires the v2 Adjudicator work below.
- **OI attestation verification is deferred.** Open interest lacks a clean cross-exchange consensus value (OI is venue-local, not fungible across exchanges the way funding rates are comparable). Rather than auto-passing OI attestations — which would dilute the meaning of "verified" — OI jobs are held out of Phase A until a sound verification source is defined.
- **Adjudicator is operator-run.** v1 uses a single operator-controlled Adjudicator, invoked only on attestation-fraud disputes. v2 roadmap: decentralize adjudication (committee or restaked-operator model), open dispute filing permissionlessly (50%-of-bond filer stake, 20% filer reward), and extend dispute scope beyond attestation fraud only where a deterministic verification rule exists for the new claim type.

### Roadmap

1. ✅ Foundry test suite for `BondHook.sol` (bond lock/unlock, slash + split, two-axis bond rate + 110% floor, new-provider cap) — **done, 31 tests passing**
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

## Dual-Tier Signal Commissioning (x402, Arc/Circle Gateway)

PCONF is a dedicated wallet (never part of the autonomous tick roster —
not in ROSTER_ROLES / getActiveRoles under any ROLLOUT_PHASE) that exposes
two paid HTTP endpoints via Circle's x402 Gateway batching SDK:

- `POST /commission-signal/open` ($0.01) — plaintext on-chain description.
- `POST /commission-signal/confidential` ($0.05) — on-chain description carries
  a commit-hash (`CONF_<ASSET>_<window>=<hash>`), not the raw value. The raw
  value is returned to the paying buyer immediately (within the commissioning
  call itself) and relayed privately to the oracle process via a local
  file-based side-channel (`confidential-relay.ts`).

**Tier selection changes WHO can see the value, never WHAT the oracle
punishes.** Both tiers go through the IDENTICAL Phase A fabrication check
(`max(3×MAD, floor)` against live 6-CEX median) — confidentiality never
weakens the deterministic punishment layer.

**Why $0.01 / $0.05, not Lepton's sub-$0.000001 nano-floor:** bonded
signals require bond economics to make sense. At sub-cent prices the bond
yield collapses below operator cost. Althemis prices at the lowest level
where slashable honesty is economically viable — and composes naturally
with downstream nano-tier consumers via Gateway batching.

**This is commit-hash confidentiality, not zero-knowledge.** The oracle
process (and anyone with filesystem access to the VPS) can always see the
raw value. What's hidden is from external third-party observers reading
on-chain data only.

**Embargo model:** the raw value becomes public again at Phase B settlement
(~8h later, same FR_WINDOW_MS as the rest of the protocol) via the existing
event log — same mechanism financial markets use for earnings embargoes.
job#234's transparency guarantee (every terminal oracle decision is logged,
verifiable, reproducible) is preserved: confidential jobs are temporarily
hidden, never permanently opaque.

**What's real vs what's staged (Plan B, extended):**
- L1 (immutable): both tiers run through the unmodified ERC8183/BondHook
  contract suite — same job lifecycle, same bond math, same slash path.
- L2 (operator demo harness): PCONF (provider) and PCONF_CONSUMER
  (buyer-side EOA) are two separately-funded wallets executing real
  on-chain transactions — createJob/fundJob signed by PCONF_CONSUMER,
  setBudget/submitSignal signed by PCONF — avoiding ERC8183's
  `client == provider` rejection (confirmed via `simulateContract`: the
  contract reverts on self-dealing with a dedicated custom error) and
  matching the same consumer/provider split already used by the
  autonomous CBUYER → PCHEAP path.
- L3 (external participants): **zero independent third parties,
  disclosed honestly** — but the full x402 payment loop has been exercised
  end-to-end against both tiers using a real, independently-funded
  ephemeral buyer EOA (Circle Gateway deposit → `gateway.pay()` → 402
  challenge resolved → settlement). Verified on-chain for both tiers:

  | Tier | Job ID | Settle amount | Submit tx |
  |---|---|---|---|
  | open | 899 | $0.01 | [`0xd0d2b206...`](https://testnet.arcscan.app/tx/0xd0d2b206d236b742ee1e9fd5c8e758898afd58b6482a5f78dcc3d2069c75e259) |
  | confidential | 911 | $0.05 | [`0x41d8cec6...`](https://testnet.arcscan.app/tx/0x41d8cec6667fa56ee9638fb7791e663221e3f70ef4c0d2680853caf5176d6b90) |

  Both submit transactions route through Arc's native [Transaction Memo
  contract](https://testnet.arcscan.app/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505)
  (`to == MEMO`), preserve `msg.sender` as the PCONF provider via
  `CallFrom`, and emit a `Memo` event with `memoId == jobId` — giving any
  external observer a deterministic on-chain index from commissioning
  payment to settled job. The buyer client used for this verification is
  a probe script, not a production-grade integration; what's verified is
  the payment-to-settlement path itself, not a polished buyer UX.

**Known scope limitation:** the confidential relay schema currently carries
only `{value, nonce, asset, window}` — no `z`/`dir`. Confidential-tier jobs
therefore always settle as Phase B `no_contest` (skill axis unaffected,
reliability axis unaffected). Extending the relay to carry directional
claims is a small follow-up, not required for the submission core.

## Future Work: ZK / TEE / MPC alternatives to commit-hash confidentiality

A zero-knowledge range proof (prove `|value - median| <= threshold` without
revealing `value`) would remove the "oracle operator can see it" caveat
entirely — but circuit development is a week-plus undertaking, and on-chain
verification gas cost would dwarf PCHEAP's sub-cent budget model. TEE/MPC
approaches were also considered and rejected: they relocate trust to a
hardware vendor or an N-of-M operator set, and Althemis currently runs a
single oracle operator (N≥2 MPC requirements don't apply). Commit-hash
confidentiality with a disclosed embargo window was chosen as the option
deliverable within the hackathon timeframe, with the trust model stated
plainly rather than obscured.

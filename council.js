'use strict';
// ── council.js (Althemis Consumer) ───────────────────────────────
// Provider×3からシグナルを受け取り、Council討論で統合判断を出力する。
// 取引執行は行わない。判断結果をArbiter×3へ渡すのは呼び出し側の責務。
//
// Entry point:
//   const { runConsumerCycle } = require('./council');
//   const verdict = await runConsumerCycle(signals);
//
// signals: {
//   fr:     { direction: 'long'|'short'|'neutral', strength: 0-1, frZ: number, baselineReady: bool }
//   oi:     { momentum: number, trend: 'up'|'down'|'flat' }
//   regime: { phase: string, riskLevel: 'risk_on'|'neutral'|'risk_off' }
// }

require('dotenv').config();
const fs = require('fs');
const { applyRegimeGate, loadRegimeState } = require('./regime_classifier');
const { runDebate, callLLM }               = require('./core/debate');
const { calibrateConfidence, computeTier } = require('./core/calibration');
const { loadPostMortems }                  = require('./core/postmortem');

// ── Constants ─────────────────────────────────────────────────────
const MAX_DEBATE_ROUNDS = parseInt(process.env.MAX_DEBATE_ROUNDS || '2');
const SNAPSHOTS_FILE    = process.env.SNAPSHOTS_FILE    || '/home/agent/althemis/snapshots.json';
const POSTMORTEM_FILE   = process.env.POSTMORTEM_FILE   || '/home/agent/althemis/post_mortems.json';

// ── サーキットブレーカー ──────────────────────────────────────────
// 直近N件の連続lossでアクションを抑制
const CONSEC_LOSS_THRESHOLD = parseInt(process.env.CONSEC_LOSS_THRESHOLD || '3');

function checkCircuitBreaker(postMortems) {
  if (!postMortems || postMortems.length === 0) return false;
  const recent = postMortems.slice(0, CONSEC_LOSS_THRESHOLD);
  if (recent.length < CONSEC_LOSS_THRESHOLD) return false;
  const allLoss = recent.every(m => m.result === 'loss');
  if (allLoss) {
    console.warn(`[circuit] ${CONSEC_LOSS_THRESHOLD} consecutive losses — breaker ON`);
  }
  return allLoss;
}

// ── Post-Mortem履歴ロード ─────────────────────────────────────────
function loadRecentPostMortems(n = 3) {
  return loadPostMortems(POSTMORTEM_FILE).slice(0, n);
}

// ── スナップショット保存 ──────────────────────────────────────────
function saveSnapshot(signals, verdict, debate) {
  try {
    let snaps = [];
    if (fs.existsSync(SNAPSHOTS_FILE)) {
      snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    }
    snaps.unshift({
      timestamp:         new Date().toISOString(),
      signals,
      verdict,
      disagreementIndex: debate?.disagreementIndex ?? null,
      converged:         debate?.converged         ?? null,
      rounds:            debate?.rounds            ?? null,
    });
    if (snaps.length > 200) snaps = snaps.slice(0, 200);
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snaps, null, 2));
  } catch (e) {
    console.error('[snapshot] save failed:', e.message);
  }
}

// ── Prompt Builders ───────────────────────────────────────────────
// context shape: { signals, postMortems, regimeState }

function buildArchitectPrompt(ctx, prevProposal, prevAudit, round) {
  const { signals, postMortems } = ctx;
  const { fr, oi, regime } = signals;

  const pmSummary = postMortems.length > 0
    ? postMortems.map(m => `${m.side} ${m.result} ${m.pnl_pct}% — ${m.analysis}`).join(' | ')
    : 'none yet';

  const base = `You are the Architect in an AI signal marketplace evaluation council.
Three specialist Provider agents have submitted trading signals. Your job is to integrate them into a unified directional verdict.

Signals from Providers:
- FR Provider:     direction=${fr.direction} strength=${fr.strength} frZ=${fr.frZ} baselineReady=${fr.baselineReady}
- OI Provider:     momentum=${oi.momentum} trend=${oi.trend}
- Regime Provider: phase=${regime.phase} riskLevel=${regime.riskLevel}

Recent Post-Mortems: ${pmSummary}

Rules:
- If baselineReady=false OR fr.direction="neutral" OR fr.strength < 0.4: action="hold"
- If regime.riskLevel="risk_off": reduce confidence by 0.2, minimum hold at 0.4
- oiMomentum > 0.003 = crowd still building → reduce confidence 0.15
- Cap confidence at 0.9
- action must match fr.direction exactly (do NOT flip)

Respond ONLY in JSON. reasoning = ONE sentence, max 10 words.
{ "action": "long"|"short"|"hold", "confidence": 0-1, "reasoning": "..." }`;

  if (round === 1) return base;

  return base + `

This is revision round ${round}/${MAX_DEBATE_ROUNDS}.
Your previous proposal: ${JSON.stringify(prevProposal)}
Auditor objection: "${prevAudit?.feedback}"
- Keep action="${prevProposal.action}" (direction locked)
- If objection is valid: lower confidence 0.1–0.2
- If objection is wrong: maintain confidence with counter-argument
- Drop below 0.4 → change action to "hold"`;
}

function buildAuditorPrompt(proposal, ctx, round, prevFeedback) {
  const { signals } = ctx;
  const { fr, oi, regime } = signals;

  const base = `You are the Auditor (Red Team) evaluating a signal integration proposal.

Proposal under review: ${JSON.stringify(proposal)}

Signal context:
- FR Provider: frZ=${fr.frZ} direction=${fr.direction} strength=${fr.strength}
- OI Provider: momentum=${oi.momentum} trend=${oi.trend}
- Regime: phase=${regime.phase} riskLevel=${regime.riskLevel}

Your job: find reasons this consensus could be WRONG.
List exactly 3 scenarios where following this signal loses money. Reference at least one observable indicator per scenario.
If risk is acceptable: approved=true. If not: approved=false.

Respond ONLY in JSON:
{
  "approved": true|false,
  "confidence": 0-1,
  "feedback": "worst-case scenario in one sentence",
  "scenarios": ["Scenario 1: ...", "Scenario 2: ...", "Scenario 3: ..."]
}`;

  if (round === 1) return base;

  return base + `

This is audit round ${round}/${MAX_DEBATE_ROUNDS}.
Your previous objection was: "${prevFeedback}"
The Architect has revised their proposal (new confidence: ${proposal.confidence}).
Re-evaluate with fresh eyes. If risk is adequately addressed: approved=true.`;
}

// ── Consumer メインサイクル ───────────────────────────────────────
//
// 戻り値:
// {
//   action:            'long'|'short'|'hold'
//   confidence:        number (raw)
//   calibrated:        number (history-adjusted)
//   disagreementIndex: number 0-1
//   converged:         bool
//   rounds:            number
//   circuitBreaker:    bool
//   debate:            { proposals, audits, ... }
//   signals:           (入力をそのままecho)
//   timestamp:         ISO string
// }
async function runConsumerCycle(signals) {
  const timestamp    = new Date().toISOString();
  const postMortems  = loadRecentPostMortems(10);
  const regimeState  = loadRegimeState?.() ?? null;

  // サーキットブレーカー
  const circuitBreaker = checkCircuitBreaker(postMortems);
  if (circuitBreaker) {
    const verdict = {
      action: 'hold', confidence: 0, calibrated: 0,
      disagreementIndex: 0, converged: true, rounds: 0,
      circuitBreaker: true, debate: null, signals, timestamp,
      note: 'circuit breaker active — consecutive losses'
    };
    saveSnapshot(signals, verdict, null);
    return verdict;
  }

  // regime gate (risk_off → holdを強制)
  const { fr } = signals;
  const directionSignal = {
    direction: fr.direction,
    strength:  fr.strength,
    frZ:       fr.frZ
  };

  // Council討論
  const ctx = { signals, postMortems, regimeState };
  const debate = await runDebate(
    { ...ctx, directionSignal },
    { buildArchitectPrompt, buildAuditorPrompt },
    { maxRounds: MAX_DEBATE_ROUNDS }
  );

  const { proposal, disagreementIndex, converged, rounds } = debate;

  // Confidence較正 (frZ bucket × 履歴winRate)
  const history = postMortems.map(m => ({
    result:         m.result,
    signalStrength: m.frZ_at_entry ?? 0
  }));
  const cal = calibrateConfidence(proposal.confidence, fr.frZ, history);

  const verdict = {
    action:            proposal.action,
    confidence:        proposal.confidence,
    calibrated:        cal.calibrated,
    calibrationMeta:   cal,
    disagreementIndex,
    converged,
    rounds,
    circuitBreaker:    false,
    debate,
    signals,
    timestamp,
  };

  saveSnapshot(signals, verdict, debate);

  console.log(
    `[consumer] action=${verdict.action} conf=${verdict.confidence} cal=${verdict.calibrated} ` +
    `DI=${disagreementIndex} converged=${converged} R${rounds}`
  );

  return verdict;
}

module.exports = { runConsumerCycle };

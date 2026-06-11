'use strict';
// ── core/debate.js ────────────────────────────────────────────────
// 汎用多段ディベートエンジン (Architect → Auditor → 収束 or maxRounds)
//
// 使い方:
//   const { runDebate, callLLM, buildDisagreementIndex } = require('./core/debate');
//
//   const result = await runDebate(context, {
//     buildArchitectPrompt: (ctx, prevProposal, prevAudit, round) => `...`,
//     buildAuditorPrompt:   (proposal, ctx, round, prevFeedback) => `...`,
//   }, { maxRounds: 2 });
//
// context には任意のドメインデータを詰める。
// directionSignal を含む場合は enforceDirectionGate が自動適用される。

// ── LLM呼び出し（フォールバック付き）──────────────────────────────
async function callLLM(prompt, fallback = {}, model = null) {
  try {
    const useModel = model || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model:           useModel,
        max_tokens:      1024,
        messages:        [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    if (data.error) {
      console.warn(`[llm] API error: ${data.error.message} → fallback`);
      return fallback;
    }
    const text = data.choices?.[0]?.message?.content || '{}';
    try { return JSON.parse(text); } catch { return fallback; }
  } catch (e) {
    console.warn(`[llm] fetch failed: ${e.message} → fallback`);
    return fallback;
  }
}

// ── Disagreement Index (0=完全合意, 1=最大不一致) ──────────────────
// roundScore  0〜0.5: ラウンド数に比例
// rejectScore 0 or 0.3: 最終audit未承認なら+0.3
// confScore   0〜0.2: confidence乖離に比例
function buildDisagreementIndex(rounds, proposals, audits) {
  if (!proposals.length || !audits.length) return 0;
  const maxRounds     = parseInt(process.env.MAX_DEBATE_ROUNDS || '2');
  const finalAudit    = audits[audits.length - 1];
  const finalProposal = proposals[proposals.length - 1];

  const roundScore  = ((rounds - 1) / Math.max(maxRounds - 1, 1)) * 0.5;
  const rejectScore = finalAudit.approved ? 0 : 0.3;
  const confGap     = Math.abs((finalProposal.confidence || 0) - (finalAudit.confidence || 0));
  const confScore   = Math.min(confGap, 1) * 0.2;

  return parseFloat(Math.min(roundScore + rejectScore + confScore, 1.0).toFixed(3));
}

// ── 方向ゲート ────────────────────────────────────────────────────
// direction=neutral → 強制hold
// action ≠ direction → 強制hold + 警告
function enforceDirectionGate(proposal, directionSignal) {
  const dir = directionSignal?.direction;
  if (dir === 'neutral' || !dir) {
    if (proposal.action !== 'hold') {
      console.warn(`[gate] neutral → forced hold (llm=${proposal.action})`);
      proposal.action = 'hold';
      proposal.confidence = 0;
    }
    return proposal;
  }
  if (proposal.action !== 'hold' && proposal.action !== dir) {
    console.warn(`[gate] mismatch: signal=${dir} llm=${proposal.action} → forced hold`);
    proposal.action = 'hold';
    proposal.confidence = 0;
  }
  return proposal;
}

// ── 多段ディベートループ ───────────────────────────────────────────
//
// promptBuilders:
//   buildArchitectPrompt(ctx, prevProposal, prevAudit, round) → string
//     round=1 時は prevProposal/prevAudit = null
//   buildAuditorPrompt(proposal, ctx, round, prevFeedback) → string
//     round=1 時は prevFeedback = null
//
// opts:
//   maxRounds: number (default: MAX_DEBATE_ROUNDS env or 2)
//
// 戻り値:
//   { proposal, audit, proposals[], audits[], rounds, converged, disagreementIndex }
async function runDebate(context, { buildArchitectPrompt, buildAuditorPrompt }, opts = {}) {
  const maxRounds = opts.maxRounds || parseInt(process.env.MAX_DEBATE_ROUNDS || '2');
  const proposals = [];
  const audits    = [];
  let converged   = false;
  let rounds      = 0;

  // ── Round 1: Architect 初回提案 ──
  const firstProposal = await callLLM(
    buildArchitectPrompt(context, null, null, 1),
    { action: 'hold', confidence: 0, reasoning: 'LLM unavailable — safe hold' }
  );
  if (context.directionSignal) enforceDirectionGate(firstProposal, context.directionSignal);
  proposals.push(firstProposal);
  rounds = 1;
  console.log(`[architect R1] action=${firstProposal.action} confidence=${firstProposal.confidence}`);

  // hold → Auditorスキップ、Disagreement=0
  if (firstProposal.action === 'hold') {
    const holdAudit = {
      approved:  false,
      confidence: 0,
      feedback:  'hold — audit skipped',
      scenarios: []
    };
    audits.push(holdAudit);
    converged = true;
    console.log('[debate] hold — skipping debate');
    return { proposal: firstProposal, audit: holdAudit, proposals, audits, rounds, converged, disagreementIndex: 0 };
  }

  // ── Round 1: Auditor ──
  const firstAudit = await callLLM(
    buildAuditorPrompt(firstProposal, context, 1, null),
    { approved: false, confidence: 0, feedback: 'LLM unavailable — conservative reject', scenarios: [] }
  );
  audits.push(firstAudit);
  console.log(`[auditor R1] approved=${firstAudit.approved} confidence=${firstAudit.confidence}`);

  if (firstAudit.approved) {
    converged = true;
    console.log('[debate] converged at R1');
  }

  // ── Round 2..maxRounds (未収束の場合) ──
  for (let r = 2; r <= maxRounds && !converged; r++) {
    const prevProposal = proposals[proposals.length - 1];
    const prevAudit    = audits[audits.length - 1];

    const revisedProposal = await callLLM(
      buildArchitectPrompt(context, prevProposal, prevAudit, r),
      { action: 'hold', confidence: 0, reasoning: 'LLM unavailable — safe hold' }
    );
    if (context.directionSignal) enforceDirectionGate(revisedProposal, context.directionSignal);
    proposals.push(revisedProposal);
    rounds = r;
    console.log(`[architect R${r}] action=${revisedProposal.action} confidence=${revisedProposal.confidence}`);

    const audit = await callLLM(
      buildAuditorPrompt(revisedProposal, context, r, prevAudit.feedback),
      { approved: false, confidence: 0, feedback: 'LLM unavailable — conservative reject', scenarios: [] }
    );
    audits.push(audit);
    console.log(`[auditor R${r}] approved=${audit.approved} confidence=${audit.confidence}`);

    if (audit.approved) {
      converged = true;
      console.log(`[debate] converged at R${r}`);
    }
  }

  const finalProposal       = proposals[proposals.length - 1];
  const finalAudit          = audits[audits.length - 1];
  const disagreementIndex   = buildDisagreementIndex(rounds, proposals, audits);

  if (!converged) {
    console.log(`[debate] maxRounds(${maxRounds}) reached — disagreementIndex=${disagreementIndex}`);
  }

  return { proposal: finalProposal, audit: finalAudit, proposals, audits, rounds, converged, disagreementIndex };
}

module.exports = { callLLM, buildDisagreementIndex, enforceDirectionGate, runDebate };

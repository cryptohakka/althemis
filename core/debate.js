// ── core/debate.js ────────────────────────────────────────────────
// 汎用多段ディベートエンジン (Architect → Auditor → 収束 or maxRounds)
//
// 使い方:
//   import { runDebate, callLLM, buildDisagreementIndex } from './core/debate.js';
//
//   const result = await runDebate(context, {
//     buildArchitectPrompt: (ctx, prevProposal, prevAudit, round) => `...`,
//     buildAuditorPrompt:   (proposal, ctx, round, prevFeedback) => `...`,
//   }, { maxRounds: 2 });
//
// context には任意のドメインデータを詰める。
// directionSignal を含む場合は enforceDirectionGate が自動適用される。
//
// approvalFloor (opts.approvalFloor / env AUDITOR_APPROVAL_FLOOR, default 0.65):
//   audit.approved===false でも audit.confidence がこの値以上なら収束扱いにする
//   決定論的セーフティネット。LLM側の「ベアシナリオを3つ書かせてから判定させる」
//   プロンプト構造が持つ拒否anchoringを、エンジン側で吸収する保険。
//   本筋の対処はbuildAuditorPrompt側(anchoring除去)。これはPercepTrade/StratumFlow
//   でも再発した同型病理への、プロジェクト共通エンジン層での恒久セーフティネット。

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

// ── Auditor承認判定 (決定論的フロア付き) ────────────────────────────
// approved===true なら無条件で承認。
// approved===false でも confidence が approvalFloor 以上なら承認扱いにする。
function isApproved(audit, approvalFloor) {
  if (audit.approved === true) return true;
  const conf = audit.confidence ?? 0;
  if (conf >= approvalFloor) {
    console.log(`[debate] approval floor override: approved=false but confidence=${conf} >= floor=${approvalFloor}`);
    return true;
  }
  return false;
}

// ── 多段ディベートループ ───────────────────────────────────────────
async function runDebate(context, { buildArchitectPrompt, buildAuditorPrompt }, opts = {}) {
  const maxRounds     = opts.maxRounds     || parseInt(process.env.MAX_DEBATE_ROUNDS || '2');
  const approvalFloor = opts.approvalFloor ?? parseFloat(process.env.AUDITOR_APPROVAL_FLOOR || '0.65');
  const proposals = [];
  const audits    = [];
  let converged   = false;
  let rounds      = 0;

  const firstProposal = await callLLM(
    buildArchitectPrompt(context, null, null, 1),
    { action: 'hold', confidence: 0, reasoning: 'LLM unavailable — safe hold' }
  );
  if (context.directionSignal) enforceDirectionGate(firstProposal, context.directionSignal);
  proposals.push(firstProposal);
  rounds = 1;
  console.log(`[architect R1] action=${firstProposal.action} confidence=${firstProposal.confidence}`);

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

  const firstAudit = await callLLM(
    buildAuditorPrompt(firstProposal, context, 1, null),
    { approved: false, confidence: 0, feedback: 'LLM unavailable — conservative reject', scenarios: [] }
  );
  audits.push(firstAudit);
  console.log(`[auditor R1] approved=${firstAudit.approved} confidence=${firstAudit.confidence}`);

  if (isApproved(firstAudit, approvalFloor)) {
    converged = true;
    console.log('[debate] converged at R1');
  }

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

    if (isApproved(audit, approvalFloor)) {
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

export { callLLM, buildDisagreementIndex, enforceDirectionGate, runDebate };

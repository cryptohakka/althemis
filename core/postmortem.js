'use strict';
// ── core/postmortem.js ────────────────────────────────────────────
// Post-Mortem分析 + slash判定の土台
//
// PerceptradeからのDiff:
//   - CROWD_EVENTS_FILE / SNAPSHOTS_FILE の直読みを排除
//   - opts.getCurrentSignalZ  : async () => number|null  (現在のfrZ等)
//   - opts.getRecentEvents    : async () => string[]     (コンテキストイベント)
//   - opts.postMortemFile     : string (保存先、デフォルト=POSTMORTEM_FILE env)
//
// slash判定:
//   runPostMortem の戻り値に slashVerdict を追加
//   { slash: boolean, reason: string, slashPct: number }
//   slashPct: 0〜1 (bond slashの割合、tier/乖離率に応じて設定)
//
// Althemis Provider slash条件:
//   result='loss' AND reversion.frZ_reverted=false → シグナルが外れた
//   → slashPct = SLASH_PCT env (default 0.1 = 10% of bond)

const fs      = require('fs');
const { callLLM } = require('./debate');

const DEFAULT_POSTMORTEM_FILE = process.env.POSTMORTEM_FILE || '/home/agent/althemis/post_mortems.json';

// ── frZ/シグナルZ Reversion計算 ───────────────────────────────────
// entry/closeはシグナルのZ値(frZなど)
// 戻り値: { frZ_revert_ratio, frZ_reverted, frZ_sign_flipped } | null
function computeReversion(entry, close) {
  if (entry === null || entry === undefined || close === null || close === undefined) return null;
  if (Math.abs(entry) < 0.01) return null;
  const ratio = (Math.abs(entry) - Math.abs(close)) / Math.abs(entry);
  return {
    frZ_revert_ratio: parseFloat(ratio.toFixed(4)),
    frZ_reverted:     ratio > 0,
    frZ_sign_flipped: (entry * close) < 0,
  };
}

// ── slash判定ロジック ─────────────────────────────────────────────
// pm: runPostMortemの結果オブジェクト
// 戻り値: { slash: boolean, reason: string, slashPct: number }
function computeSlashVerdict(pm) {
  const slashPct = parseFloat(process.env.SLASH_PCT || '0.1');

  // シグナルが外れた AND 逆方向に動いた → slash
  if (pm.result === 'loss' && pm.reversion && !pm.reversion.frZ_reverted) {
    return {
      slash:    true,
      reason:   `signal did not revert (ratio=${pm.reversion.frZ_revert_ratio}, sign_flipped=${pm.reversion.frZ_sign_flipped})`,
      slashPct: slashPct
    };
  }

  // lossだが逆方向まではいかなかった → slash半額
  if (pm.result === 'loss') {
    return {
      slash:    true,
      reason:   `loss but partial reversion (ratio=${pm.reversion?.frZ_revert_ratio ?? 'N/A'})`,
      slashPct: slashPct * 0.5
    };
  }

  return { slash: false, reason: 'win — no slash', slashPct: 0 };
}

// ── Post-Mortem実行 ───────────────────────────────────────────────
//
// closedPosition: {
//   openPriceAvg, holdSide|side,
//   frZ_at_entry, frZ_min_during_hold, frZ_max_during_hold,
//   marginSize
// }
// exitPrice: number
// closeReason: string
//
// opts: {
//   getCurrentSignalZ : async () => number|null   (現在のfrZ取得関数)
//   getRecentEvents   : async () => string[]      (最近のイベントリスト)
//   postMortemFile    : string                    (保存先ファイルパス)
//   leverage          : number                    (default: LEVERAGE env)
//   entryFeePct       : number                    (default: ENTRY_FEE_PCT env)
//   exitFeePct        : number                    (default: EXIT_FEE_PCT env)
// }
//
// 戻り値: post-mortemオブジェクト (ファイルにも保存)
async function runPostMortem(closedPosition, exitPrice, closeReason, opts = {}) {
  try {
    if (!closedPosition) return null;

    const postMortemFile = opts.postMortemFile || DEFAULT_POSTMORTEM_FILE;
    const entryPrice     = parseFloat(closedPosition.openPriceAvg || 0);
    const side           = closedPosition.holdSide || closedPosition.side || 'unknown';

    const leverage   = opts.leverage    ?? parseFloat(process.env.LEVERAGE       || '2');
    const entryFee   = opts.entryFeePct ?? parseFloat(process.env.ENTRY_FEE_PCT  || '0.0006');
    const exitFee    = opts.exitFeePct  ?? parseFloat(process.env.EXIT_FEE_PCT   || '0.0006');

    // PnL計算
    let pnl = { raw: null, leveraged: null, fee_pct: null, net: null, usdt: null };
    if (entryPrice > 0) {
      const dir        = side === 'long' ? 1 : -1;
      const raw        = (exitPrice - entryPrice) / entryPrice * dir;
      const lev        = raw * leverage;
      const feePct     = (entryFee + exitFee) * leverage;
      const net        = lev - feePct;
      const marginUsdt = parseFloat(closedPosition.marginSize || 0);
      pnl = {
        raw:       parseFloat((raw * 100).toFixed(4)),
        leveraged: parseFloat((lev * 100).toFixed(4)),
        fee_pct:   parseFloat((feePct * 100).toFixed(4)),
        net:       parseFloat((net * 100).toFixed(4)),
        usdt:      marginUsdt > 0 ? parseFloat((net * marginUsdt * leverage).toFixed(4)) : null
      };
    }
    const pnlPct = pnl.net;

    // コンテキスト取得(注入関数 or 空配列/null)
    let recentEvents = [];
    try {
      if (typeof opts.getRecentEvents === 'function') {
        recentEvents = await opts.getRecentEvents();
      }
    } catch (e) {
      console.warn(`[postmortem] getRecentEvents failed: ${e.message}`);
    }

    let currentSignalZ = null;
    try {
      if (typeof opts.getCurrentSignalZ === 'function') {
        currentSignalZ = await opts.getCurrentSignalZ();
      }
    } catch (e) {
      console.warn(`[postmortem] getCurrentSignalZ failed: ${e.message}`);
    }

    // frZ reversion
    const reversion = computeReversion(
      closedPosition.frZ_at_entry ?? null,
      currentSignalZ
    );

    // LLM分析
    const prompt = `You are a trading post-mortem analyst. Write a brief analysis of this closed trade.

Trade summary:
- Side: ${side}
- Entry price: $${entryPrice}
- Exit price: $${exitPrice}
- PnL: ${pnlPct !== null ? pnlPct + '%' : 'unknown'}
- Close reason: ${closeReason}
- frZ at entry: ${closedPosition.frZ_at_entry ?? 'N/A'}
- frZ at close: ${currentSignalZ ?? 'N/A'}
- frZ revert ratio: ${reversion?.frZ_revert_ratio ?? 'N/A'} (>0 = reverted toward 0, <0 = extended further)
- frZ min during hold: ${closedPosition.frZ_min_during_hold ?? 'N/A'}
- frZ max during hold: ${closedPosition.frZ_max_during_hold ?? 'N/A'}
- Recent events: ${recentEvents.length > 0 ? recentEvents.join('; ') : 'none'}

Write ONE concise sentence explaining why this trade won or lost, focusing on whether the contrarian FR signal played out as expected.

Respond ONLY with JSON: {"result":"win"|"loss"|"unknown","pnl_pct":${pnlPct ?? null},"analysis":"<one sentence>"}`;

    const parsed = await callLLM(prompt, {
      result:   pnlPct !== null ? (pnlPct >= 0 ? 'win' : 'loss') : 'unknown',
      pnl_pct:  pnlPct,
      analysis: 'LLM unavailable — result inferred from PnL'
    });

    // slash判定
    const pmBase = {
      ...parsed,
      timestamp:             new Date().toISOString(),
      side,
      entryPrice,
      exitPrice,
      closeReason,
      frZ_at_entry:          closedPosition.frZ_at_entry ?? null,
      frZ_at_close:          currentSignalZ,
      frZ_min_during_hold:   closedPosition.frZ_min_during_hold ?? null,
      frZ_max_during_hold:   closedPosition.frZ_max_during_hold ?? null,
      reversion,
      pnl,
    };
    const slashVerdict = computeSlashVerdict(pmBase);
    const pm = { ...pmBase, slashVerdict };

    // ファイル保存
    let mortems = [];
    try {
      if (fs.existsSync(postMortemFile)) {
        mortems = JSON.parse(fs.readFileSync(postMortemFile, 'utf8'));
      }
    } catch {}
    mortems.unshift(pm);
    fs.writeFileSync(postMortemFile, JSON.stringify(mortems.slice(0, 200), null, 2));

    console.log(`[postmortem] result=${pm.result} pnl=${pnlPct}% slash=${slashVerdict.slash}(${slashVerdict.slashPct*100}%)`);
    return pm;

  } catch (e) {
    console.error(`[postmortem] error: ${e.message}`);
    return null;
  }
}

// ── Post-Mortem履歴ロード ─────────────────────────────────────────
function loadPostMortems(postMortemFile) {
  const path = postMortemFile || DEFAULT_POSTMORTEM_FILE;
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch {}
  return [];
}

module.exports = { computeReversion, computeSlashVerdict, runPostMortem, loadPostMortems };

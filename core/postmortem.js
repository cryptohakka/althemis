// ── core/postmortem.js ────────────────────────────────────────────
// Post-Mortem分析 + slash判定の土台

import fs from 'fs';
import { callLLM } from './debate.js';

const DEFAULT_POSTMORTEM_FILE = process.env.POSTMORTEM_FILE || '/home/agent/althemis/post_mortems.json';

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

function computeSlashVerdict(pm) {
  const slashPct = parseFloat(process.env.SLASH_PCT || '0.1');

  if (pm.result === 'loss' && pm.reversion && !pm.reversion.frZ_reverted) {
    return {
      slash:    true,
      reason:   `signal did not revert (ratio=${pm.reversion.frZ_revert_ratio}, sign_flipped=${pm.reversion.frZ_sign_flipped})`,
      slashPct: slashPct
    };
  }

  if (pm.result === 'loss') {
    return {
      slash:    true,
      reason:   `loss but partial reversion (ratio=${pm.reversion?.frZ_revert_ratio ?? 'N/A'})`,
      slashPct: slashPct * 0.5
    };
  }

  return { slash: false, reason: 'win — no slash', slashPct: 0 };
}

async function runPostMortem(closedPosition, exitPrice, closeReason, opts = {}) {
  try {
    if (!closedPosition) return null;

    const postMortemFile = opts.postMortemFile || DEFAULT_POSTMORTEM_FILE;
    const entryPrice     = parseFloat(closedPosition.openPriceAvg || 0);
    const side           = closedPosition.holdSide || closedPosition.side || 'unknown';

    const leverage   = opts.leverage    ?? parseFloat(process.env.LEVERAGE       || '2');
    const entryFee   = opts.entryFeePct ?? parseFloat(process.env.ENTRY_FEE_PCT  || '0.0006');
    const exitFee    = opts.exitFeePct  ?? parseFloat(process.env.EXIT_FEE_PCT   || '0.0006');

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

    const reversion = computeReversion(
      closedPosition.frZ_at_entry ?? null,
      currentSignalZ
    );

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

function loadPostMortems(postMortemFile) {
  const path = postMortemFile || DEFAULT_POSTMORTEM_FILE;
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch {}
  return [];
}

export { computeReversion, computeSlashVerdict, runPostMortem, loadPostMortems };

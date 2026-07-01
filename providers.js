// ── providers.js ──────────────────────────────────────────────────
// 3つのシグナルProvider (論理エージェント)。データ取得はcex.jsに委譲。
//
//   getFRSignal()     → { signal: {direction,strength,frZ,...}, providerId, ... }
//   getOISignal()     → { signal: {momentum,trend}, providerId, ... }
//   getRegimeSignal() → { signal: {phase,riskLevel,...}, providerId, ... }
//   fetchAllSignals() → Consumer向け一括取得

import 'dotenv/config';
import fs from 'fs';
import { fetchAllSources } from './cex.js';
import { loadRegimeState } from './regime_classifier.js';

// ── Provider ID / Bond Address (シミュレーション用) ───────────────
const PROVIDERS = {
  fr:     { id: 'provider-fr-001',     bond: process.env.BOND_ADDR_FR     || '0x0000000000000000000000000000000000000001' },
  oi:     { id: 'provider-oi-001',     bond: process.env.BOND_ADDR_OI     || '0x0000000000000000000000000000000000000002' },
  regime: { id: 'provider-regime-001', bond: process.env.BOND_ADDR_REGIME || '0x0000000000000000000000000000000000000003' },
};

// ── 履歴永続化 ────────────────────────────────────────────────────
const FR_HISTORY_FILE   = process.env.FR_HISTORY_FILE   || '/home/agent/althemis/fr_history.json';
const PREV_SOURCES_FILE = process.env.PREV_SOURCES_FILE || '/home/agent/althemis/prev_sources.json';
const FR_HISTORY_MAX    = 288; // 24h @ 5min

function loadJSON(path, fallback) {
  try { if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
  return fallback;
}
function saveJSON(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

// ── 時系列MAD (FR宣言offsetの動的算出用。oracle.tsのmedianMadと同一ロジック) ──
function medianMad(values) {
  if (values.length === 0) return { median: 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const deviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const madMid = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 === 0 ? (deviations[madMid - 1] + deviations[madMid]) / 2 : deviations[madMid];
  return { median, mad };
}

// ── シグナル計算 (FR z-score逆張り + OI枯渇ゲート) ────────────────
function calcDirectionSignal(sources, prevSources = [], frHistory = []) {
  const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;

  let oiMomentum = 0;
  if (prevSources.length > 0) {
    let tc = 0, tp = 0;
    for (const src of sources) {
      const prev = prevSources.find(p => p.exchange === src.exchange);
      tc += src.oi || 0;
      tp += prev?.oi || 0;
    }
    oiMomentum = (tp > 0 && tc > 0) ? Math.log(tc / tp) : 0;
  }

  let frZ = 0, baselineReady = false;
  if (frHistory.length >= 20) {
    baselineReady = true;
    const mean = frHistory.reduce((a, b) => a + b, 0) / frHistory.length;
    const sd   = Math.sqrt(frHistory.reduce((a, b) => a + (mean - b) ** 2, 0) / frHistory.length);
    frZ = sd > 0 ? (avgFR - mean) / sd : 0;
  }

  const absZ          = Math.abs(frZ);
  const EXTREME_Z     = parseFloat(process.env.FR_Z_EXTREME   || '2.0');
  const Z_THRESHOLD   = parseFloat(process.env.FR_Z_THRESHOLD || '1.5');
  const frRegime      = absZ >= EXTREME_Z ? 'extreme' : 'normal';
  const extremeFactor = frRegime === 'extreme' ? 0.7 : 1.0;

  let direction = 'neutral', strength = 0;

  if (!baselineReady) {
    console.log(`[fr-provider] baseline building (${frHistory.length}/20) — neutral`);
    return { direction, strength, avgFR, oiMomentum, frZ, baselineReady, frRegime, extremeFactor, mad: 0 };
  }

  const OI_BUILD = 0.003;   // OI激増中 → 逆張り見送り
  const OI_FADE  = -0.001;  // OI枯渇 → 逆張りボーナス

  if (frZ >= Z_THRESHOLD && oiMomentum <= OI_BUILD) {
    direction = 'short';
    const zPart   = Math.min(1, (frZ - Z_THRESHOLD) / 1.5);
    const oiBonus = oiMomentum <= OI_FADE ? 0.3 : 0;
    strength = (0.4 + zPart * 0.3 + oiBonus) * extremeFactor;
  } else if (frZ <= -Z_THRESHOLD && oiMomentum <= OI_BUILD) {
    direction = 'long';
    const zPart   = Math.min(1, (Math.abs(frZ) - Z_THRESHOLD) / 1.5);
    const oiBonus = oiMomentum <= OI_FADE ? 0.3 : 0;
    strength = (0.4 + zPart * 0.3 + oiBonus) * extremeFactor;
  }

  const { mad: frMad } = medianMad(frHistory);
  return {
    direction,
    strength:   parseFloat(Math.min(strength, 1).toFixed(3)),
    avgFR,
    oiMomentum: parseFloat(oiMomentum.toFixed(6)),
    frZ:        parseFloat(frZ.toFixed(2)),
    baselineReady, frRegime, extremeFactor,
    mad: frMad
  };
}

// ── 共有データ取得 (1サイクル1回のfetchで全Provider共用) ──────────
let _cycleCache = null;
let _cycleCacheTs = 0;
const CACHE_TTL_MS = 30 * 1000;

async function getSources() {
  const now = Date.now();
  if (_cycleCache && (now - _cycleCacheTs) < CACHE_TTL_MS) return _cycleCache;
  _cycleCache   = await fetchAllSources();
  _cycleCacheTs = now;
  return _cycleCache;
}

// ── Provider 1: FR Signal ─────────────────────────────────────────
async function getFRSignal() {
  const { id, bond } = PROVIDERS.fr;
  try {
    const sources     = await getSources();
    if (sources.length === 0) throw new Error('no CEX sources');
    const frHistory   = loadJSON(FR_HISTORY_FILE, []);
    const prevSources = loadJSON(PREV_SOURCES_FILE, []);

    const signal = calcDirectionSignal(sources, prevSources, frHistory);

    const bitgetSrc = sources.find(s => s.exchange === 'bitget');
    if (bitgetSrc?.longShortRatio) signal.longShortRatio = bitgetSrc.longShortRatio;

    const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;
    frHistory.unshift(avgFR);
    saveJSON(FR_HISTORY_FILE, frHistory.slice(0, FR_HISTORY_MAX));
    saveJSON(PREV_SOURCES_FILE, sources);

    console.log(`[fr-provider] dir=${signal.direction} str=${signal.strength} frZ=${signal.frZ} src=${sources.length}`);
    return { signal, providerId: id, bondAddress: bond, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error(`[fr-provider] error: ${e.message}`);
    return {
      signal: { direction: 'neutral', strength: 0, frZ: 0, baselineReady: false, frRegime: 'normal', extremeFactor: 1 },
      providerId: id, bondAddress: bond, timestamp: new Date().toISOString(), error: e.message
    };
  }
}

// ── Provider 2: OI Signal ─────────────────────────────────────────
async function getOISignal() {
  const { id, bond } = PROVIDERS.oi;
  try {
    const sources     = await getSources();
    if (sources.length === 0) throw new Error('no CEX sources');
    const prevSources = loadJSON(PREV_SOURCES_FILE, []);

    let momentum = 0;
    if (prevSources.length > 0) {
      let tc = 0, tp = 0;
      for (const src of sources) {
        const prev = prevSources.find(p => p.exchange === src.exchange);
        tc += src.oi || 0;
        tp += prev?.oi || 0;
      }
      momentum = (tp > 0 && tc > 0) ? Math.log(tc / tp) : 0;
    }

    const trend  = momentum > 0.001 ? 'up' : momentum < -0.001 ? 'down' : 'flat';
    const signal = { momentum: parseFloat(momentum.toFixed(6)), trend };

    console.log(`[oi-provider] momentum=${signal.momentum} trend=${signal.trend}`);
    return { signal, providerId: id, bondAddress: bond, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error(`[oi-provider] error: ${e.message}`);
    return {
      signal: { momentum: 0, trend: 'flat' },
      providerId: id, bondAddress: bond, timestamp: new Date().toISOString(), error: e.message
    };
  }
}

// ── Provider 3: Regime Signal ─────────────────────────────────────
async function getRegimeSignal() {
  const { id, bond } = PROVIDERS.regime;
  try {
    const state      = loadRegimeState();
    const phase      = state.current_regime     || 'mean_reverting';
    const confidence = state.current_confidence || 0.5;

    const riskLevel =
      phase === 'trending_up'   ? 'risk_on'  :
      phase === 'trending_down' ? 'risk_off' :
      phase === 'chop'          ? 'risk_off' : 'neutral';

    const signal = { phase, riskLevel, confidence, stale: state.stale || false };

    console.log(`[regime-provider] phase=${phase} riskLevel=${riskLevel} conf=${confidence}`);
    return { signal, providerId: id, bondAddress: bond, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error(`[regime-provider] error: ${e.message}`);
    return {
      signal: { phase: 'mean_reverting', riskLevel: 'neutral', confidence: 0.5, stale: true },
      providerId: id, bondAddress: bond, timestamp: new Date().toISOString(), error: e.message
    };
  }
}

// ── Consumer向け一括取得 ──────────────────────────────────────────
async function fetchAllSignals() {
  const fr     = await getFRSignal();
  const [oi, regime] = await Promise.all([getOISignal(), getRegimeSignal()]);
  return {
    fr:     fr.signal,
    oi:     oi.signal,
    regime: regime.signal,
    meta:   { fr, oi, regime }
  };
}

export { getFRSignal, getOISignal, getRegimeSignal, fetchAllSignals };

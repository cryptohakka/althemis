'use strict';
// ── core/calibration.js ───────────────────────────────────────────
// 汎用 confidence 較正 + Providerティア計算 (Bronze/Silver/Gold)
//
// ① calibrateConfidence: rawConfidence × 過去実績winRateをブレンド
//    frZ依存を排除し、signalStrengthバケットに汎用化
//
// ② computeTier: 一致率(accuracyRate) + サンプル数でBSG昇降格
//    Althemis Provider評価に使用

// ── ① Confidence較正 ─────────────────────────────────────────────
//
// signalStrength: 0〜任意(絶対値)。元コードのMath.abs(frZ)に相当する汎用値
//   例: frZ → Math.abs(frZ)、シグナルスコア → rawScore、一致率 → そのまま
//
// history: 過去の結果配列 [{ result: 'win'|'loss', signalStrength: number }, ...]
//   PerceptradeのpostMortems互換にするには呼び出し側でmappingする
//
// buckets: { low: <1, medium: 1〜2, high: >=2 } — env上書き可
//   FR_BUCKET_LOW  = 1 (default)
//   FR_BUCKET_MED  = 2 (default)
//
// 戻り値: { calibrated, winRate, n, bucket, historyWeight, raw, note? }
function calibrateConfidence(rawConfidence, signalStrength, history = []) {
  const bucketLow = parseFloat(process.env.FR_BUCKET_LOW || '1');
  const bucketMed = parseFloat(process.env.FR_BUCKET_MED || '2');
  const absS = Math.abs(signalStrength || 0);
  const bucket = absS < bucketLow ? 'low' : absS < bucketMed ? 'medium' : 'high';

  if (!history || history.length === 0) {
    return { calibrated: rawConfidence, winRate: null, n: 0, bucket, note: 'no history' };
  }

  const matching = history.filter(m => {
    const mS = Math.abs(m.signalStrength ?? m.frZ_at_entry ?? 0);
    if (bucket === 'low')    return mS < bucketLow;
    if (bucket === 'medium') return mS >= bucketLow && mS < bucketMed;
    return mS >= bucketMed;
  });

  const n = matching.length;
  if (n < 3) {
    return { calibrated: rawConfidence, winRate: null, n, bucket, note: 'insufficient samples' };
  }

  const wins    = matching.filter(m => m.result === 'win').length;
  const winRate = parseFloat((wins / n).toFixed(3));

  // historyWeightはサンプル数に比例、最大0.4(n>=10で上限)
  const historyWeight = parseFloat(Math.min(n / 10, 0.4).toFixed(2));
  const calibrated = parseFloat(
    ((rawConfidence * (1 - historyWeight)) + (winRate * historyWeight)).toFixed(3)
  );

  return { calibrated, winRate, n, bucket, historyWeight, raw: rawConfidence };
}

// ── ② Provider Tier計算 ──────────────────────────────────────────
// Althemis: シグナルの「予測 vs oracle一致率」でProviderのtierを決定
//
// accuracyRate: 0〜1 (直近N件の一致率)
// n:            サンプル数
//
// 閾値(env上書き可):
//   TIER_GOLD_ACC   = 0.65, TIER_GOLD_N   = 10
//   TIER_SILVER_ACC = 0.55, TIER_SILVER_N = 5
//   それ以下 → Bronze
//
// 戻り値: { tier, accuracyRate, n, feeMultiplier }
//   feeMultiplier: Gold=1.5, Silver=1.2, Bronze=1.0
//   (Consumer支払い手数料への乗数、tier設計に応じて調整)
function computeTier(accuracyRate, n) {
  const goldAcc    = parseFloat(process.env.TIER_GOLD_ACC   || '0.65');
  const goldN      = parseInt(process.env.TIER_GOLD_N       || '10');
  const silverAcc  = parseFloat(process.env.TIER_SILVER_ACC || '0.55');
  const silverN    = parseInt(process.env.TIER_SILVER_N     || '5');

  let tier, feeMultiplier;

  if (accuracyRate >= goldAcc && n >= goldN) {
    tier           = 'Gold';
    feeMultiplier  = 1.5;
  } else if (accuracyRate >= silverAcc && n >= silverN) {
    tier           = 'Silver';
    feeMultiplier  = 1.2;
  } else {
    tier           = 'Bronze';
    feeMultiplier  = 1.0;
  }

  return { tier, accuracyRate, n, feeMultiplier };
}

// ── ③ PerceptTrade互換ラッパー ────────────────────────────────────
// 旧: calibrateConfidence(rawConfidence, frZ, postMortems)
// → postMortems配列をhistory形式に変換して新APIへ渡す
function calibrateConfidenceLegacy(rawConfidence, frZ, postMortems) {
  const history = (postMortems || []).map(m => ({
    result:         m.result,
    signalStrength: m.frZ_at_entry ?? 0
  }));
  return calibrateConfidence(rawConfidence, frZ, history);
}

module.exports = { calibrateConfidence, computeTier, calibrateConfidenceLegacy };

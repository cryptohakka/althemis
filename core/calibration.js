// ── core/calibration.js ───────────────────────────────────────────
// 汎用 confidence 較正 + Providerティア計算 (Bronze/Silver/Gold)

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

  const historyWeight = parseFloat(Math.min(n / 10, 0.4).toFixed(2));
  const calibrated = parseFloat(
    ((rawConfidence * (1 - historyWeight)) + (winRate * historyWeight)).toFixed(3)
  );

  return { calibrated, winRate, n, bucket, historyWeight, raw: rawConfidence };
}

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

function calibrateConfidenceLegacy(rawConfidence, frZ, postMortems) {
  const history = (postMortems || []).map(m => ({
    result:         m.result,
    signalStrength: m.frZ_at_entry ?? 0
  }));
  return calibrateConfidence(rawConfidence, frZ, history);
}

export { calibrateConfidence, computeTier, calibrateConfidenceLegacy };

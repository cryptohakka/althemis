import 'dotenv/config';
import fs from 'fs';

const SNAPSHOTS_FILE = process.env.SNAPSHOTS_FILE || '/home/agent/perceptrade/snapshots.json';
const REGIME_FILE    = process.env.REGIME_FILE    || '/home/agent/perceptrade/regime_state.json';

const VALID_REGIMES = ['mean_reverting', 'trending_up', 'trending_down', 'chop'];

const DEFAULT_STATE = {
  current_regime:     'mean_reverting',
  current_confidence: 0.5,
  pending_regime:     null,
  pending_count:      0,
  last_updated:       null,
  stale:              false,
  history:            []
};

function loadRegimeState() {
  try {
    if (!fs.existsSync(REGIME_FILE)) return { ...DEFAULT_STATE };
    return JSON.parse(fs.readFileSync(REGIME_FILE, 'utf8'));
  } catch { return { ...DEFAULT_STATE }; }
}

function saveRegimeState(state) {
  try {
    fs.writeFileSync(REGIME_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    console.error('[regime] save failed:', e.message);
  }
}

function buildClassifierInput() {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return null;
    const snaps = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
    if (snaps.length < 12) {
      console.log(`[regime] not enough snapshots (${snaps.length}/12) — skipping`);
      return null;
    }
    const window = snaps.slice(0, 288);
    const step = Math.max(1, Math.floor(window.length / 12));
    const sampled = [];
    for (let i = 0; i < window.length && sampled.length < 12; i += step) {
      const s = window[i];
      sampled.push({ ts: s.timestamp, frZ: s.frZ ?? null, price: s.btcPrice ?? null, fr: s.avgFR ?? null });
    }
    sampled.reverse();
    const frZs   = sampled.map(s => s.frZ).filter(v => v !== null);
    const prices = sampled.map(s => s.price).filter(v => v !== null);
    const avgFrZ = frZs.length ? (frZs.reduce((a, b) => a + b, 0) / frZs.length).toFixed(3) : 'N/A';
    const priceChange24h = prices.length >= 2
      ? ((prices[prices.length - 1] - prices[0]) / prices[0] * 100).toFixed(2)
      : null;
    return { sampled, avgFrZ, priceChange24h };
  } catch(e) {
    console.error('[regime] input build failed:', e.message);
    return null;
  }
}

async function callLLM(input) {
  const { sampled, avgFrZ, priceChange24h } = input;
  const prompt = `You are a crypto market regime classifier. Analyze the following 24-hour data from a BTC perpetual futures system and classify the current market regime.

## Data (12 sampled points, oldest to newest)
${sampled.map(s => `  ${s.ts}: frZ=${s.frZ?.toFixed(2) ?? 'N/A'}, price=$${s.price?.toFixed(0) ?? 'N/A'}, avgFR=${s.fr !== null ? (s.fr * 100).toFixed(5) + '%' : 'N/A'}`).join('\n')}

## Summary
- 24h avg frZ: ${avgFrZ}
- 24h price change: ${priceChange24h !== null ? priceChange24h + '%' : 'N/A'}

## Task
Classify the regime for a contrarian FR mean-reversion strategy:
- "mean_reverting": FR oscillates around baseline, no sustained price trend. Contrarian signals reliable.
- "trending_up": Sustained upward price trend. LONG signals penalized (crowd over-short less likely to reverse). SHORT signals valid.
- "trending_down": Sustained downward price trend. SHORT signals penalized. LONG signals valid.
- "chop": High noise, no clear trend or mean-reversion. Both directions penalized.

contrarian_confidence (0.0-1.0): how reliably contrarian FR signals will work in this regime.

Respond ONLY with valid JSON, no markdown:
{"regime":"<value>","contrarian_confidence":<0.0-1.0>,"reasoning":"<1-2 sentences>"}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function validate(parsed) {
  if (!VALID_REGIMES.includes(parsed.regime)) throw new Error(`invalid regime: ${parsed.regime}`);
  if (typeof parsed.contrarian_confidence !== 'number' ||
      parsed.contrarian_confidence < 0 || parsed.contrarian_confidence > 1) {
    parsed.contrarian_confidence = 0.5;
  }
  return parsed;
}

function applyHysteresis(state, newRegime, newConfidence) {
  // 同じregimeなら常に更新
  if (newRegime === state.current_regime) {
    return { ...state, current_confidence: newConfidence, pending_regime: null, pending_count: 0 };
  }
  // pending蓄積（confに関係なく）
  const newCount = state.pending_regime === newRegime ? state.pending_count + 1 : 1;
  // conf>=0.6 OR 同じシグナルが2回連続 → 切り替え
  if (newConfidence >= 0.6 || newCount >= 2) {
    console.log(`[regime] confirmed: ${state.current_regime} → ${newRegime} (conf:${newConfidence}, count:${newCount})`);
    return { ...state, current_regime: newRegime, current_confidence: newConfidence, pending_regime: null, pending_count: 0 };
  }
  console.log(`[regime] pending: ${newRegime} count=${newCount}/2 conf=${newConfidence}`);
  return { ...state, pending_regime: newRegime, pending_count: newCount };
}

const STALE_LIMIT_MS = 2 * 60 * 60 * 1000;

const REGIME_PENALTY = {
  mean_reverting: { long: 1.0, short: 1.0 },
  trending_up:    { long: 0.3, short: 1.0 },
  trending_down:  { long: 1.0, short: 0.3 },
  chop:           { long: 0.5, short: 0.5 }
};

function applyRegimeGate(decision) {
  let regime     = 'mean_reverting';
  let confidence = 0.5;
  let stale      = false;

  try {
    if (!fs.existsSync(REGIME_FILE)) {
      console.log('[regime] no regime_state.json — defaulting to mean_reverting');
    } else {
      const state = JSON.parse(fs.readFileSync(REGIME_FILE, 'utf8'));
      const age   = state.last_updated ? Date.now() - new Date(state.last_updated).getTime() : Infinity;
      if (age > STALE_LIMIT_MS) {
        console.log(`[regime] STALE (${Math.round(age/60000)}min) — ×0.5 fallback`);
        stale = true;
      } else {
        regime     = state.current_regime || 'mean_reverting';
        confidence = state.current_confidence ?? 0.5;
      }
    }
  } catch(e) {
    console.error('[regime] load failed:', e.message);
  }

  if (decision.action !== 'long' && decision.action !== 'short') return decision;

  const penalty   = stale ? 0.5 : (REGIME_PENALTY[regime]?.[decision.action] ?? 1.0);
  const finalSize = parseFloat((decision.size_pct * penalty * confidence).toFixed(3));
  const MIN_SIZE  = 0.05;

  if (finalSize < MIN_SIZE) {
    console.log(`[regime] ${regime} → ${decision.action} ${decision.size_pct} × ×${penalty} × conf${confidence} = ${finalSize} < ${MIN_SIZE} → HOLD`);
    return { ...decision, action: 'hold', size_pct: 0, regime_blocked: true };
  }
  if (penalty < 1.0 || confidence < 1.0) {
    console.log(`[regime] ${regime} penalty ×${penalty} conf ${confidence}: ${decision.size_pct} → ${finalSize}`);
  }
  return { ...decision, size_pct: finalSize, regime, regime_penalty: penalty };
}

async function classifyRegime() {
  console.log('[regime] starting classification...');
  const input = buildClassifierInput();
  if (!input) return;

  let state = loadRegimeState();
  let parsed;
  try {
    const raw = await callLLM(input);
    parsed = validate(raw);
    console.log(`[regime] LLM → ${parsed.regime} conf=${parsed.contrarian_confidence} "${parsed.reasoning}"`);
  } catch(e) {
    console.error(`[regime] LLM failed: ${e.message} — holding current regime`);
    return;
  }

  state = applyHysteresis(state, parsed.regime, parsed.contrarian_confidence);
  state.history = [{ ts: new Date().toISOString(), regime: parsed.regime, confidence: parsed.contrarian_confidence, reasoning: parsed.reasoning }, ...(state.history || [])].slice(0, 10);
  state.last_updated = new Date().toISOString();
  state.stale = false;
  saveRegimeState(state);
  console.log(`[regime] saved — current: ${state.current_regime} (${state.current_confidence})`);
}

export { classifyRegime, applyRegimeGate, loadRegimeState };

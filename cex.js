// ── cex.js ────────────────────────────────────────────────────────
// 全CEXのpublic市場データ取得層。認証不要のエンドポイントのみ使用。
// 6 CEX: Bybit / Hyperliquid / OKX / Binance / KuCoin / Bitget
//
// 各getterの戻り値: { exchange, fr, oi, longShortRatio? } | null

import axios from 'axios';
const TIMEOUT = 5000;

async function getBybitFR(symbol = 'BTCUSDT') {
  const res = await axios.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'linear', symbol }, timeout: TIMEOUT
  });
  const d = res.data.result.list[0];
  return { exchange: 'bybit', fr: parseFloat(d.fundingRate), oi: parseFloat(d.openInterest) };
}

async function getHyperliquidFR(symbol = 'BTC') {
  const res = await axios.post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }, { timeout: TIMEOUT });
  const meta = res.data[0].universe;
  const ctxs = res.data[1];
  const idx  = meta.findIndex(m => m.name === symbol);
  if (idx === -1) return null;
  return {
    exchange: 'hyperliquid',
    fr: parseFloat(ctxs[idx].funding),
    oi: parseFloat(ctxs[idx].openInterest) * parseFloat(ctxs[idx].markPx)
  };
}

async function getOkxFR(instId = 'BTC-USDT-SWAP') {
  const [frRes, oiRes] = await Promise.all([
    axios.get('https://www.okx.com/api/v5/public/funding-rate', { params: { instId }, timeout: TIMEOUT }),
    axios.get('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume', { params: { ccy: 'BTC', period: '5m' }, timeout: TIMEOUT })
  ]);
  const oi = oiRes.data.data?.length ? parseFloat(oiRes.data.data[oiRes.data.data.length - 1][1]) : 0;
  return { exchange: 'okx', fr: parseFloat(frRes.data.data[0].fundingRate), oi };
}

async function getBinanceFR(symbol = 'BTCUSDT') {
  const [frRes, oiRes] = await Promise.all([
    axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { params: { symbol }, timeout: TIMEOUT }),
    axios.get('https://fapi.binance.com/fapi/v1/openInterest', { params: { symbol }, timeout: TIMEOUT })
  ]);
  return { exchange: 'binance', fr: parseFloat(frRes.data.lastFundingRate), oi: parseFloat(oiRes.data.openInterest) };
}

async function getKucoinFR(symbol = 'XBTUSDTM') {
  const [frRes, contractRes] = await Promise.all([
    axios.get(`https://api-futures.kucoin.com/api/v1/funding-rate/${symbol}/current`, { timeout: TIMEOUT }),
    axios.get(`https://api-futures.kucoin.com/api/v1/contracts/${symbol}`, { timeout: TIMEOUT })
  ]);
  const oi = parseFloat(contractRes.data.data.openInterest) * parseFloat(contractRes.data.data.multiplier);
  return { exchange: 'kucoin', fr: parseFloat(frRes.data.data.value), oi };
}

// Bitget: public market endpoints (署名不要)
async function getBitgetFR(symbol = 'BTCUSDT') {
  const base = 'https://api.bitget.com';
  const [frRes, oiRes, lsRes] = await Promise.all([
    axios.get(`${base}/api/v2/mix/market/current-fund-rate`, {
      params: { symbol, productType: 'USDT-FUTURES' }, timeout: TIMEOUT
    }),
    axios.get(`${base}/api/v2/mix/market/open-interest`, {
      params: { symbol, productType: 'USDT-FUTURES' }, timeout: TIMEOUT
    }),
    axios.get(`${base}/api/v2/mix/market/account-long-short`, {
      params: { symbol, productType: 'USDT-FUTURES', period: '5m' }, timeout: TIMEOUT
    }).catch(() => null)
  ]);
  const lsData = lsRes?.data?.data?.[0];
  return {
    exchange: 'bitget',
    fr: parseFloat(frRes.data.data[0].fundingRate),
    oi: parseFloat(oiRes.data.data.openInterestList[0].size),
    longShortRatio: lsData ? {
      longRatio:  parseFloat(lsData.longPositionRatio),
      shortRatio: parseFloat(lsData.shortPositionRatio),
      ratio:      parseFloat(lsData.longShortPositionRatio)
    } : null
  };
}

// 価格取得 (Price Oracle用)
async function getBTCPrice() {
  // Binanceをprimary、失敗時はBybitへフォールバック
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price', {
      params: { symbol: 'BTCUSDT' }, timeout: TIMEOUT
    });
    return parseFloat(res.data.price);
  } catch {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear', symbol: 'BTCUSDT' }, timeout: TIMEOUT
    });
    return parseFloat(res.data.result.list[0].lastPrice);
  }
}

// ── 全CEX並列取得 (失敗したCEXはskip) ────────────────────────────
async function fetchAllSources() {
  const results = await Promise.allSettled([
    getBybitFR(), getHyperliquidFR(), getOkxFR(), getBinanceFR(), getKucoinFR(), getBitgetFR()
  ]);
  const sources = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) console.warn(`[cex] ${failed}/6 sources failed`);
  return sources;
}

export {
  getBybitFR, getHyperliquidFR, getOkxFR, getBinanceFR, getKucoinFR, getBitgetFR,
  getBTCPrice, fetchAllSources
};

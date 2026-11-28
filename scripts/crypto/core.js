'use strict';

// Research mathematics and a paper ledger only. No account or order API exists here.
const crypto = require('node:crypto');
const VERSION = 'crypto-research-0.3.0';
const ASSETS = Object.freeze({
  btc: {symbol: 'btc', name: 'Bitcoin', indexSymbol: 'BRTI', instrumentPrefix: 'cpc'},
  eth: {symbol: 'eth', name: 'Ethereum', indexSymbol: 'ETHUSD_RTI', instrumentPrefix: 'cpceth'}
});
const iso = ms => new Date(ms).toISOString();
const finite = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function amount(x) {
  return x?.currency === 'USD' && finite(x.value) ? Number(x.value) : null;
}
function validateConfig(c) {
  if (c.venue !== 'POLYMARKET_US' || c.liveTradingEnabled !== false) throw new Error('This collector supports paper research only');
  if (!Array.isArray(c.assets) || !c.assets.length || c.assets.some(a => !ASSETS[a]) || new Set(c.assets).size !== c.assets.length) throw new Error('Invalid research assets');
  if (!Array.isArray(c.horizons) || c.horizons.length !== 2 || !c.horizons.includes(5) || !c.horizons.includes(15)) throw new Error('Both 5m and 15m horizons are required');
  if (c.maximumMarkets < c.assets.length * c.horizons.length) throw new Error('Market limit must cover every configured stream');
  for (const [key, lo, hi] of [
    ['paperBankrollUsd', 100, 1e6], ['paperContractsPerOrder', 1, 100],
    ['paperMaxExposureUsd', 1, 1000], ['minimumEdge', .01, .3], ['slippageReserve', .001, .05],
    ['simulatedLatencyMs', 1000, 5000], ['maxSourceAgeSeconds', 2, 30],
    ['minimumRemainingSeconds', 10, 120], ['studentDegreesOfFreedom', 3, 30],
    ['minimumTrainingSamples', 120, 3000], ['historyHours', 24, 60],
    ['ewmaHalfLifeMinutes', 2, 60], ['ewmaLookbackMinutes', 60, 720],
    ['requestTimeoutMs', 2000, 15000], ['maximumMarkets', 1, 6], ['settlementChecksPerRun', 1, 20]
  ]) if (!Number.isFinite(c[key]) || c[key] < lo || c[key] > hi) throw new Error('Invalid ' + key);
  return c;
}
function parseMarket(raw) {
  const t = raw?.assetPriceTerms;
  const asset = t?.asset?.symbol?.toLowerCase(), spec = ASSETS[asset];
  const start = Date.parse(t?.windowStart), end = Date.parse(t?.windowEnd);
  if (!/^[a-z0-9-]{1,160}$/.test(raw?.slug || '') ||
      t?.marketType !== 'ASSET_PRICE_MARKET_TYPE_UP_DOWN' ||
      t?.asset?.assetClass !== 'ASSET_CLASS_CRYPTO' || !spec ||
      t?.indexSymbol !== spec.indexSymbol || ![300000, 900000].includes(end - start)) return null;
  const rules = String(raw.description || '');
  // Typed terms establish identity; rules must also confirm the settlement statistic.
  const verified = new RegExp('60\\s+' + spec.indexSymbol + '\\s+prices', 'i').test(rules) && /simple average/i.test(rules) && /greater than or equal/i.test(rules);
  const fee = finite(raw.feeCoefficient) && Number(raw.feeCoefficient) >= 0 && Number(raw.feeCoefficient) <= 1 ? Number(raw.feeCoefficient) : null;
  const strike = amount(t.priceToBeat);
  return {
    asset, assetName: spec.name, indexSymbol: spec.indexSymbol,
    slug: raw.slug, eventSlug: raw.events?.[0]?.slug || raw.slug.replace(new RegExp('^' + spec.instrumentPrefix + '-'), ''),
    title: String(raw.question || asset.toUpperCase() + ' Up or Down'), horizon: (end - start) / 60000 + 'm',
    startAt: iso(start), endAt: iso(end), referencePrice: strike > 0 ? strike : null,
    priceDecimals: Number.isInteger(t.priceDecimals) ? t.priceDecimals : 2,
    rulesVerified: verified, rulesHash: crypto.createHash('sha256').update(rules).digest('hex'),
    description: rules, feeCoefficient: fee, status: raw.status || 'UNKNOWN',
    active: raw.active === true && raw.closed !== true,
    url: 'https://polymarket.us/event/' + (raw.events?.[0]?.slug || raw.slug.replace(new RegExp('^' + spec.instrumentPrefix + '-'), ''))
  };
}
function parseCandles(payload, bucket, now, asset = 'btc') {
  if (!ASSETS[asset]) throw new Error('Unsupported price asset');
  const series = payload?.series?.find(s => s.asset?.assetClass === 'ASSET_CLASS_CRYPTO' && s.asset.symbol?.toLowerCase() === asset);
  if (!series || series.currency !== 'USD' || series.bucket !== bucket || !Array.isArray(series.candles)) throw new Error('Unexpected ' + asset.toUpperCase() + ' reference history schema');
  const step = bucket === 'ASSET_PRICE_BUCKET_1M' ? 60 : 1;
  const seen = new Map();
  for (const r of series.candles) {
    const at = Number(r.timestamp), price = Number(r.close), ticks = Number(r.tickCount);
    // An in-progress candle or a carried-forward empty bucket is never an observation.
    if (Number.isInteger(at) && at + step <= now / 1000 && price > 0 && Number.isFinite(price) && ticks > 0) seen.set(at, {at, price, ticks});
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}
function logGamma(z) {
  const p = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < .5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z--; let x = .9999999999998099;
  for (let i = 0; i < p.length; i++) x += p[i] / (z + i + 1);
  const t = z + p.length - .5;
  return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(x);
}
function betaFraction(a, b, x) {
  const tiny = 1e-30; let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    for (const aa of [m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)), -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; const delta = d * c; h *= delta;
      if (aa < 0 && Math.abs(delta - 1) < 1e-12) return h;
    }
  }
  return h;
}
function betaRegularized(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? front * betaFraction(a, b, x) / a : 1 - front * betaFraction(b, a, 1 - x) / b;
}
function studentCDF(x, df) {
  if (x === 0) return .5;
  const tail = .5 * betaRegularized(df / (df + x * x), df / 2, .5);
  return x > 0 ? 1 - tail : tail;
}
function solve(a, b) {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < b.length; k++) {
    let pivot = k;
    for (let i = k + 1; i < b.length; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    [m[k], m[pivot]] = [m[pivot], m[k]];
    if (Math.abs(m[k][k]) < 1e-12) throw new Error('Singular volatility fit');
    const v = m[k][k]; for (let j = k; j <= b.length; j++) m[k][j] /= v;
    for (let i = 0; i < b.length; i++) if (i !== k) {
      const f = m[i][k]; for (let j = k; j <= b.length; j++) m[i][j] -= f * m[k][j];
    }
  }
  return m.map(r => r[b.length]);
}
function ewmaVariance(candles, halfLifeMinutes = 10, lookbackMinutes = 180) {
  if (!(halfLifeMinutes > 0) || !Number.isInteger(lookbackMinutes) || lookbackMinutes < 60) throw new Error('Invalid EWMA settings');
  const rows = candles.slice(-(lookbackMinutes + 1));
  if (rows.length < 61) return {status: 'WARMING_UP', samples: Math.max(0, rows.length - 1)};
  const lambda = Math.exp(-Math.LN2 / halfLifeMinutes);
  let variance = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].at - rows[i - 1].at !== 60) return {status: 'DATA_GAP', samples: i - 1};
    const squaredReturn = Math.log(rows[i].price / rows[i - 1].price) ** 2;
    if (!Number.isFinite(squaredReturn)) return {status: 'INVALID_DATA', samples: i - 1};
    variance = variance === null ? squaredReturn : lambda * variance + (1 - lambda) * squaredReturn;
  }
  return {status: variance > 0 ? 'READY' : 'NO_VARIANCE', minuteVariance: variance, lambda,
    halfLifeMinutes, lookbackMinutes, samples: rows.length - 1,
    trainingFrom: iso(rows[0].at * 1000), trainingThrough: iso((rows.at(-1).at + 60) * 1000)};
}
function fitVariance(candles, cfg, now) {
  const returns = candles.map((c, i) => i && c.at - candles[i - 1].at === 60 ? Math.log(c.price / candles[i - 1].price) ** 2 : null);
  const valid = returns.filter(Number.isFinite), scale = mean(valid);
  if (valid.length < cfg.minimumTrainingSamples || !(scale > 0)) return {status: 'WARMING_UP', samples: valid.length, version: VERSION};
  const floor = scale * 1e-6;
  const features = i => {
    const r = returns.slice(i - 14, i + 1);
    if (r.length !== 15 || !r.every(Number.isFinite)) return null;
    return [1, ...[r[14], mean(r.slice(-5)), mean(r)].map(v => Math.log(Math.max(floor, v) / scale))];
  };
  const rows = [];
  for (let i = 15; i < returns.length - 1; i++) {
    const x = features(i);
    if (x && Number.isFinite(returns[i + 1])) rows.push({x, y: Math.log(Math.max(floor, returns[i + 1]) / scale)});
  }
  if (rows.length < cfg.minimumTrainingSamples) return {status: 'WARMING_UP', samples: rows.length, version: VERSION};
  const a = Array.from({length: 4}, () => Array(4).fill(0)), b = Array(4).fill(0);
  for (const {x, y} of rows) for (let i = 0; i < 4; i++) {
    b[i] += x[i] * y;
    for (let j = 0; j < 4; j++) a[i][j] += x[i] * x[j];
  }
  for (let i = 1; i < 4; i++) a[i][i] += .01 * rows.length;
  const coefficients = solve(a, b), dot = x => x.reduce((s, v, i) => s + v * coefficients[i], 0);
  // Smearing converts a conditional log-variance fit back to a variance estimate.
  const smearing = mean(rows.map(({x, y}) => Math.exp(clamp(y - dot(x), -30, 30))));
  const x = features(returns.length - 1);
  if (!x) return {status: 'DATA_GAP', samples: rows.length, version: VERSION};
  const raw = scale * Math.exp(dot(x)) * smearing;
  const baseline = returns.slice(-60);
  if (!baseline.every(Number.isFinite) || baseline.length !== 60 || now / 1000 - candles.at(-1).at > 150) return {status: 'DATA_GAP', samples: rows.length, version: VERSION};
  const baselineVariance = mean(baseline), bounded = raw < scale * .02 || raw > scale * 50;
  return {
    version: VERSION, status: bounded ? 'UNSTABLE_FIT' : 'PROVISIONAL', fittedAt: iso(now),
    trainingFrom: iso(candles[0].at * 1000), trainingThrough: iso((candles.at(-1).at + 60) * 1000),
    samples: rows.length, coefficients, smearing, minuteVariance: bounded ? null : raw,
    baselineVariance, degreesOfFreedom: cfg.studentDegreesOfFreedom,
    method: 'HAR-style regression on squared one-minute reference-index close returns; fixed Student-t tails; zero drift',
    calibration: 'Unvalidated. Minute returns are a realized-variance proxy, not tick-level HAR RV.'
  };
}
function valueMarket(m, model, seconds, now, variance = model.minuteVariance) {
  if (model.asset && model.asset !== m.asset) return null;
  const last = seconds.at(-1), t = now / 1000, end = Date.parse(m.endAt) / 1000;
  if (!last || !(variance > 0) || !(m.referencePrice > 0) || t >= end || t < Date.parse(m.startAt) / 1000) return null;
  const averagingStart = end - 60;
  const observed = seconds.filter(c => c.at >= averagingStart && c.at < end);
  const expectedCount = Math.max(0, Math.min(60, Math.floor(t) - averagingStart));
  if (observed.length !== expectedCount) return null; // Never invent missing settlement samples.
  const n = 60 - observed.length;
  const expectedAverage = (observed.reduce((s, c) => s + c.price, 0) + n * last.price) / 60;
  const firstFuture = Math.max(averagingStart, last.at + 1);
  // Exact discrete Brownian covariance weights for future per-second samples.
  const effectiveSeconds = (n * n * (firstFuture - last.at) + (n - 1) * n * (2 * n - 1) / 6) / (60 * 60);
  const logVariance = variance / 60 * effectiveSeconds * (last.price / expectedAverage) ** 2;
  if (!(logVariance > 0)) return null;
  const df = model.degreesOfFreedom;
  const scale = Math.sqrt(logVariance * (df - 2) / df);
  // A rounded tie settles Up. Approximate its half-tick boundary continuously.
  const threshold = m.referencePrice - .5 * 10 ** -m.priceDecimals;
  const pUp = 1 - studentCDF(Math.log(threshold / expectedAverage) / scale, df);
  return {pUp, pDown: 1 - pUp, expectedAverage, standardDeviationUsd: expectedAverage * Math.sqrt(logVariance),
    effectiveSeconds, observedAverageSamples: observed.length, referencePrice: m.referencePrice,
    sourceAt: iso(last.at * 1000), calculatedAt: iso(now), assumption: 'Student-t approximation to the final-minute arithmetic average'};
}
function parseBook(payload, slug, receivedAt) {
  const b = payload?.marketData;
  if (b?.marketSlug !== slug || !Array.isArray(b.bids) || !Array.isArray(b.offers)) throw new Error('Book identity/schema mismatch');
  function levels(rows, direction) {
    return rows.map(r => {
      const p = amount(r.px), q = Number(r.qty);
      if (!(p > 0 && p < 1) || !Number.isFinite(q) || q < 0) throw new Error('Invalid USD book level');
      return {price: p, quantity: q};
    }).filter(r => r.quantity > 0).sort((a, b) => direction * (a.price - b.price));
  }
  const bids = levels(b.bids, -1), asks = levels(b.offers, 1), sourceTime = Date.parse(b.transactTime);
  const crossed = bids.length && asks.length && bids[0].price >= asks[0].price;
  return {receivedAt, sourceAt: Number.isFinite(sourceTime) ? iso(sourceTime) : null,
    state: b.state, usable: b.state === 'MARKET_STATE_OPEN' && !crossed && Number.isFinite(sourceTime),
    bids, asks, yesBid: bids[0]?.price ?? null, yesAsk: asks[0]?.price ?? null,
    noAsk: bids[0] ? 1 - bids[0].price : null, spread: bids.length && asks.length ? asks[0].price - bids[0].price : null};
}
function modelDiagnostics(m, model, seconds, now, har, baseline) {
  const ewma = model.ewma?.status === 'READY' && model.status === 'PROVISIONAL' ? valueMarket(m, model, seconds, now, model.ewma.minuteVariance) : null;
  const probabilities = [har?.pUp, baseline?.pUp, ewma?.pUp].filter(p => typeof p === 'number' && Number.isFinite(p));
  const spread = probabilities.length >= 2 ? Math.max(...probabilities) - Math.min(...probabilities) : null;
  return {ewma, probabilitySpread: spread,
    directionDisagreement: probabilities.length >= 2 ? probabilities.some(p => p > .5) && probabilities.some(p => p < .5) : null,
    fastToHarVolatilityRatio: model.ewma?.minuteVariance > 0 && model.minuteVariance > 0 ? Math.sqrt(model.ewma.minuteVariance / model.minuteVariance) : null,
    use: 'Research comparison only; HAR remains the entry probability'};
}
function sweep(book, side, probability, fee, cfg) {
  if (!finite(fee) || fee < 0 || fee > 1 || !book?.usable || !finite(probability)) return null;
  const levels = side === 'UP' ? book.asks : book.bids.map(l => ({price: 1 - l.price, quantity: l.quantity}));
  let remaining = cfg.paperContractsPerOrder, cost = 0, fees = 0, quantity = 0, reserve = 0;
  const fills = [];
  for (const l of levels) {
    const unitFee = fee * l.price * (1 - l.price), unitCost = l.price + unitFee + cfg.slippageReserve;
    if (unitCost >= 1 || probability - unitCost < cfg.minimumEdge) break;
    const q = Math.floor(Math.min(remaining, l.quantity) * 100) / 100;
    if (q <= 0) continue;
    fills.push({price: l.price, quantity: q}); quantity += q; remaining -= q;
    cost += l.price * q; fees += unitFee * q; reserve += cfg.slippageReserve * q;
    if (remaining < .01) break;
  }
  if (quantity < .01) return null;
  fees = Math.ceil((fees - 1e-10) * 100) / 100;
  const totalCost = cost + fees + reserve, edge = probability - totalCost / quantity;
  return edge >= cfg.minimumEdge ? {side, quantity, totalCost, fees, slippageReserve: reserve, averagePrice: cost / quantity, edge, fills, partial: remaining >= .01,
    probabilityAtSignal: probability, breakevenProbability: totalCost / quantity,
    expectedProfit: probability * quantity - totalCost,
    expectedReturnOnCost: totalCost > 0 ? (probability * quantity - totalCost) / totalCost : null} : null;
}
function decision(m, book, valuation, model, now, cfg) {
  const reasons = [];
  if (!m.rulesVerified) reasons.push('Settlement rules unverified');
  if (m.feeCoefficient === null) reasons.push('Fee coefficient missing');
  if (model.status !== 'PROVISIONAL') reasons.push('Volatility model unavailable');
  if (!valuation) reasons.push('Reference price or complete index samples unavailable');
  if (!m.active || m.status !== 'MARKET_STATUS_OPEN') reasons.push('Market not open');
  if (Date.parse(m.startAt) > now) reasons.push('Window has not started');
  if (Date.parse(m.endAt) - now < cfg.minimumRemainingSeconds * 1000) reasons.push('Too close to expiry');
  if (!book?.usable) reasons.push('Usable order book unavailable');
  for (const [label, stamp] of [['Book', book?.sourceAt], [m.indexSymbol || 'Reference index', valuation?.sourceAt]]) {
    const age = (now - Date.parse(stamp || '')) / 1000;
    if (!Number.isFinite(age) || age < -1 || age > cfg.maxSourceAgeSeconds) reasons.push(label + ' timestamp stale or missing');
  }
  if (reasons.length) return {status: 'WAIT', reasons, candidate: null};
  const options = [sweep(book, 'UP', valuation.pUp, m.feeCoefficient, cfg), sweep(book, 'DOWN', valuation.pDown, m.feeCoefficient, cfg)].filter(Boolean).sort((a, b) => b.edge - a.edge);
  return options.length ? {status: 'PAPER_CANDIDATE', reasons: ['Provisional model; simulated orders only'], candidate: options[0]} : {status: 'NO_EDGE', reasons: ['No fillable edge above the configured threshold after costs'], candidate: null};
}
function openPaperTrade(state, m, d, now, cfg, signalAt) {
  if (!d.candidate || state.trades.some(t => t.market === m.slug)) return null;
  const c = d.candidate;
  const realized = state.trades.filter(t => t.status === 'SETTLED').reduce((s, t) => s + t.pnl, 0);
  const exposure = state.trades.filter(t => t.status === 'OPEN').reduce((s, t) => s + t.totalCost, 0);
  if (exposure + c.totalCost > cfg.paperMaxExposureUsd || exposure + c.totalCost > cfg.paperBankrollUsd + realized) return null;
  const trade = {...c, id: m.slug + ':paper-v1', market: m.slug, asset: m.asset || 'btc', horizon: m.horizon, endAt: m.endAt,
    enteredAt: iso(now), signalAt, modelVersion: VERSION, feeCoefficient: m.feeCoefficient,
    entryMinimumEdge: cfg.minimumEdge, entryPolicyVersion: VERSION,
    status: 'OPEN', payout: null, pnl: null, simulation: 'Later observed book, full depth, fee rounding and adverse-price reserve; no queue-fill claim'};
  state.trades.push(trade); return trade;
}
function settleRecord(record, response, now) {
  if (response?.slug !== record.slug || ![0, 1].includes(response.settlement)) return false;
  if (record.status !== 'MARKET_STATUS_RESOLVED') return false;
  record.result = response.settlement; record.resolvedAt = iso(now); return true;
}
function comparisonScores(records) {
  const rows = records.filter(m => m.forecast && [0, 1].includes(m.result) &&
    ['pUp', 'baselinePUp', 'ewmaPUp'].every(key => typeof m.forecast[key] === 'number' && Number.isFinite(m.forecast[key])));
  const score = key => ({
    brier: rows.length ? mean(rows.map(m => (m.forecast[key] - m.result) ** 2)) : null,
    logLoss: rows.length ? mean(rows.map(m => {
      const p = clamp(m.forecast[key], 1e-12, 1 - 1e-12);
      return -m.result * Math.log(p) - (1 - m.result) * Math.log1p(-p);
    })) : null
  });
  return {samples: rows.length, har: score('pUp'), baseline: score('baselinePUp'), ewma: score('ewmaPUp'),
    cohort: 'Same prospectively captured windows with all three forecasts; overlapping windows are correlated'};
}
function edgeBucketStats(trades) {
  const definitions = [
    {id: 'below2', label: 'Below 2¢', low: -Infinity, high: .02},
    {id: '2to3', label: '2–3¢', low: .02, high: .03},
    {id: '3to5', label: '3–5¢', low: .03, high: .05},
    {id: '5plus', label: '5¢ or more', low: .05, high: Infinity},
    {id: 'unknown', label: 'Edge not recorded', low: null, high: null}
  ];
  return definitions.map(d => {
    const rows = trades.filter(t => typeof t.edge === 'number' && Number.isFinite(t.edge) ? d.id !== 'unknown' && t.edge >= d.low && t.edge < d.high : d.id === 'unknown');
    const settled = rows.filter(t => t.status === 'SETTLED');
    const cost = settled.reduce((s, t) => s + t.totalCost, 0), pnl = settled.reduce((s, t) => s + t.pnl, 0);
    return {id: d.id, label: d.label, totalTrades: rows.length, openTrades: rows.filter(t => t.status === 'OPEN').length,
      settledTrades: settled.length, wins: settled.filter(t => t.pnl > 0).length,
      winRate: settled.length ? settled.filter(t => t.pnl > 0).length / settled.length : null,
      realizedPnl: pnl, investedSettled: cost, returnOnSettledCost: cost > 0 ? pnl / cost : null,
      averageModeledEdge: rows.length && d.id !== 'unknown' ? mean(rows.map(t => t.edge)) : null};
  });
}
function stats(state, cfg) {
  const settled = state.trades.filter(t => t.status === 'SETTLED'), open = state.trades.filter(t => t.status === 'OPEN');
  const pnl = settled.reduce((s, t) => s + t.pnl, 0), exposure = open.reduce((s, t) => s + t.totalCost, 0);
  const ordered = [...settled].sort((a, b) => a.settledAt.localeCompare(b.settledAt));
  let equity = cfg.paperBankrollUsd, peak = equity, maxDrawdown = 0;
  const equityCurve = ordered.map(t => {equity += t.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); return {at: t.settledAt, equity};});
  const scores = Object.values(state.markets).filter(m => m.forecast && [0, 1].includes(m.result));
  const brier = scores.length ? mean(scores.map(m => (m.forecast.pUp - m.result) ** 2)) : null;
  const baselineBrier = scores.length ? mean(scores.map(m => (m.forecast.baselinePUp - m.result) ** 2)) : null;
  const bins = Array.from({length: 5}, (_, i) => {
    const rows = scores.filter(m => Math.min(4, Math.floor(m.forecast.pUp * 5)) === i);
    return {low: i * .2, high: (i + 1) * .2, n: rows.length, predicted: rows.length ? mean(rows.map(m => m.forecast.pUp)) : null, actual: rows.length ? mean(rows.map(m => m.result)) : null};
  });
  const streams = [];
  for (const asset of cfg.assets || ['btc']) for (const h of cfg.horizons || [5, 15]) {
    const horizon = h + 'm', records = Object.values(state.markets).filter(m => (m.asset || 'btc') === asset && m.horizon === horizon);
    const graded = records.filter(m => m.forecast && [0, 1].includes(m.result));
    const trades = state.trades.filter(t => (t.asset || 'btc') === asset && t.horizon === horizon), done = trades.filter(t => t.status === 'SETTLED');
    streams.push({asset, horizon, observedWindows: records.length, forecastWindows: records.filter(m => m.forecast).length,
      scoredMarkets: graded.length, brier: graded.length ? mean(graded.map(m => (m.forecast.pUp - m.result) ** 2)) : null,
      baselineBrier: graded.length ? mean(graded.map(m => (m.forecast.baselinePUp - m.result) ** 2)) : null,
      paperTrades: trades.length, settledTrades: done.length, realizedPnl: done.reduce((s, t) => s + t.pnl, 0), comparison: comparisonScores(records)});
  }
  return {startingBankroll: cfg.paperBankrollUsd, realizedPnl: pnl, equity: cfg.paperBankrollUsd + pnl,
    availableCash: cfg.paperBankrollUsd + pnl - exposure, openExposure: exposure, openTrades: open.length,
    settledTrades: settled.length, wins: settled.filter(t => t.pnl > 0).length,
    winRate: settled.length ? settled.filter(t => t.pnl > 0).length / settled.length : null,
    maxDrawdown, equityCurve, scoredMarkets: scores.length, brier, baselineBrier, calibration: bins, streams,
    comparison: comparisonScores(Object.values(state.markets)), entryEdgeBuckets: edgeBucketStats(state.trades)};
}
module.exports = {VERSION, ASSETS, iso, amount, validateConfig, parseMarket, parseCandles, studentCDF,
  ewmaVariance, fitVariance, valueMarket, parseBook, modelDiagnostics, sweep, decision, openPaperTrade, settleRecord,
  comparisonScores, edgeBucketStats, stats};

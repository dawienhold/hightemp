'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('./core');
const BASE = 'https://gateway.polymarket.us';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJSON(file, fallback) {
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));}
  catch (e) {if (e.code === 'ENOENT') return fallback; throw e;}
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n'); fs.renameSync(tmp, file);
}
function appendGzip(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, zlib.gzipSync(JSON.stringify(value) + '\n'));
}
function createReader(cfg, transport = global.fetch, clock = Date.now) {
  return async function read(route, query = {}) {
    if (!/^\/v1\/(search|asset-prices\/history|market\/slug\/[a-z0-9-]+|markets\/[a-z0-9-]+\/(book|settlement))$/.test(route)) throw new Error('Non-research endpoint rejected');
    const url = new URL(route, BASE);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const startedAt = C.iso(clock());
    const r = await transport(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      headers: {Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'hightemp-crypto-research/0.1 (github.com/dawienhold/hightemp)'}});
    if (!r.ok) {const e = new Error('HTTP ' + r.status + ' ' + route); e.status = r.status; throw e;}
    const body = await r.text();
    if (body.length > 8e6) throw new Error('Response exceeds research size limit');
    return {data: JSON.parse(body), startedAt, receivedAt: C.iso(clock()), url: url.href, httpAge: r.headers?.get('age') || null};
  };
}
async function collect(root, config, options = {}) {
  const cfg = C.validateConfig(config), clock = options.clock || Date.now;
  const read = options.read || createReader(cfg, global.fetch, clock), wait = options.pause || pause;
  const out = path.join(root, 'docs/data/crypto'), startedAt = C.iso(clock());
  fs.mkdirSync(out, {recursive: true});
  const lockPath = path.join(out, '.collector.lock');
  const lock = fs.openSync(lockPath, 'wx');
  const errors = [], events = [], markets = [];
  let state;
  let seconds = [], minutes = [], model = {version: C.VERSION, status: 'UNAVAILABLE', samples: 0};
  try {
    state = readJSON(path.join(out, 'state.json'), {schemaVersion: 1, version: C.VERSION, startedAt, lastSuccessAt: null, markets: {}, trades: [], lastArchivedSecond: 0, lastArchivedMinute: 0});
    if (state.schemaVersion !== 1 || !state.markets || !Array.isArray(state.trades)) throw new Error('Unknown research state; refusing to reset');
    const previous = readJSON(path.join(out, 'latest.json'), null);
    const now = Math.floor(clock() / 1000);
    const requests = await Promise.allSettled([
      read('/v1/search', {query: 'BTC Up or Down', limit: 20, page: 1}),
      read('/v1/asset-prices/history', {assets: 'crypto:btc', bucket: 'ASSET_PRICE_BUCKET_1M', from: now - cfg.historyHours * 3600, to: now}),
      read('/v1/asset-prices/history', {assets: 'crypto:btc', bucket: 'ASSET_PRICE_BUCKET_1S', from: now - 3600, to: now})
    ]);
    function result(i, label) {
      const r = requests[i];
      if (r.status === 'fulfilled') return r.value;
      errors.push(label + ': ' + r.reason.message); return null;
    }
    const discovery = result(0, 'Market discovery'), minuteResponse = result(1, 'Minute history'), secondResponse = result(2, 'BRTI history');
    if (minuteResponse) {
      try {minutes = C.parseCandles(minuteResponse.data, 'ASSET_PRICE_BUCKET_1M', now * 1000); model = C.fitVariance(minutes, cfg, clock());}
      catch (e) {errors.push('Volatility fit: ' + e.message);}
    }
    if (secondResponse) {
      try {seconds = C.parseCandles(secondResponse.data, 'ASSET_PRICE_BUCKET_1S', now * 1000);}
      catch (e) {errors.push('BRTI samples: ' + e.message);}
    }
    const seen = new Set();
    if (discovery) {
      if (!Array.isArray(discovery.data.events)) errors.push('Discovery schema missing events');
      for (const e of discovery.data.events || []) for (const raw of e.markets || []) {
        const m = C.parseMarket({...raw, events: [{slug: e.slug}]});
        if (m && !seen.has(m.slug) && Date.parse(m.endAt) > clock() && Date.parse(m.startAt) <= clock() + 15 * 60000) {
          seen.add(m.slug); markets.push(m);
        }
      }
    }
    // Search can lag a fast-rolling window. Expected identifiers are discovery
    // probes only; returned typed terms, index and settlement rules still decide
    // whether a contract is eligible. Never infer its terms from the slug.
    for (const horizon of [5, 15]) {
      const start = Math.floor(clock() / (horizon * 60000)) * horizon * 60000;
      const stamp = C.iso(start), slug = `cpc-btc-updown-${horizon}m-${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}z`;
      if (seen.has(slug)) continue;
      try {
        const response = await read('/v1/market/slug/' + slug);
        const m = C.parseMarket(response.data.market);
        if (m?.slug !== slug || Date.parse(m.startAt) !== start) throw new Error('Current-window probe identity mismatch');
        seen.add(slug); markets.push(m);
      } catch (e) {if (e.status !== 404) errors.push('Window discovery: ' + e.message);}
    }
    markets.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt));
    const snapshots = [];
    for (const m of markets.slice(0, cfg.maximumMarkets)) {
      const row = {...m, book: null, valuation: null, baseline: null, decision: {status: 'WAIT', reasons: ['Waiting for observations'], candidate: null}};
      try {
        // Discovery and the training-history fetch can take several seconds.
        // Refresh the small price window immediately before each book; never
        // relabel the older history as fresh just because it was received now.
        const priceTo = Math.floor(clock() / 1000);
        const fresh = await read('/v1/asset-prices/history', {assets: 'crypto:btc', bucket: 'ASSET_PRICE_BUCKET_1S', from: priceTo - 120, to: priceTo});
        const newest = C.parseCandles(fresh.data, 'ASSET_PRICE_BUCKET_1S', priceTo * 1000);
        seconds = [...new Map([...seconds, ...newest].map(c => [c.at, c])).values()].sort((a, b) => a.at - b.at);
        const firstResponse = await read('/v1/markets/' + m.slug + '/book');
        const at = Date.parse(firstResponse.receivedAt), book = C.parseBook(firstResponse.data, m.slug, firstResponse.receivedAt);
        if (Number(firstResponse.httpAge) > cfg.maxSourceAgeSeconds) book.usable = false;
        const value = C.valueMarket(m, model, seconds, at);
        const baseline = C.valueMarket(m, model, seconds, at, model.baselineVariance);
        Object.assign(row, {book, valuation: value, baseline, decision: C.decision(m, book, value, model, at, cfg), sampledAt: firstResponse.receivedAt});
        const saved = state.markets[m.slug] || {...m, firstObservedAt: firstResponse.receivedAt};
        Object.assign(saved, m, {lastObservedAt: firstResponse.receivedAt});
        if (!saved.forecast && value && baseline && m.active && m.status === 'MARKET_STATUS_OPEN' && model.status === 'PROVISIONAL' &&
            at - Date.parse(value.sourceAt) <= cfg.maxSourceAgeSeconds * 1000 && m.rulesVerified) {
          saved.forecast = {pUp: value.pUp, baselinePUp: baseline.pUp, at: value.calculatedAt,
            sourceAt: value.sourceAt, modelVersion: C.VERSION, minutesRemaining: (Date.parse(m.endAt) - at) / 60000};
        }
        state.markets[m.slug] = saved;
        // Fill simulation waits for a second, independently fetched book. It cannot fill
        // against the same snapshot that created a signal or claim a maker queue fill.
        if (row.decision.candidate && !state.trades.some(t => t.market === m.slug)) {
          await wait(cfg.simulatedLatencyMs);
          const next = await read('/v1/markets/' + m.slug + '/book');
          const nextBook = C.parseBook(next.data, m.slug, next.receivedAt), nextAt = Date.parse(next.receivedAt);
          if (Number(next.httpAge) > cfg.maxSourceAgeSeconds || nextAt - at < cfg.simulatedLatencyMs) nextBook.usable = false;
          const d = C.decision(m, nextBook, value, model, nextAt, cfg);
          // Keep the side originally signaled. A re-quote cannot invent a new signal.
          if (d.candidate?.side !== row.decision.candidate.side) d.candidate = null;
          const trade = C.openPaperTrade(state, m, d, nextAt, cfg, firstResponse.receivedAt);
          row.paperAction = trade ? 'SIMULATED_FILL' : 'NO_FILL';
          events.push({kind: row.paperAction, market: m.slug, at: next.receivedAt, laterBook: nextBook, decision: d, trade});
        }
      } catch (e) {errors.push(m.slug + ': ' + e.message); row.decision = {status: 'WAIT', reasons: [e.message], candidate: null};}
      snapshots.push(row);
    }
    if (!snapshots.length) errors.push('No current verified BTC 5m/15m market returned; no price or forecast is substituted');
    const pending = Object.values(state.markets).filter(m => m.result === undefined && Date.parse(m.endAt) <= clock()).sort((a, b) => (a.lastSettlementCheckAt || '').localeCompare(b.lastSettlementCheckAt || ''));
    for (const m of pending.slice(0, cfg.settlementChecksPerRun)) {
      m.lastSettlementCheckAt = C.iso(clock());
      try {
        const detail = await read('/v1/market/slug/' + m.slug), raw = detail.data.market;
        const verified = C.parseMarket(raw);
        if (!verified || verified.slug !== m.slug || verified.rulesHash !== m.rulesHash) throw new Error('Settlement identity or rules changed');
        m.status = verified.status;
        if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
        const response = await read('/v1/markets/' + m.slug + '/settlement');
        if (!C.settleRecord(m, response.data, clock())) throw new Error('Final binary settlement not confirmed');
        for (const t of state.trades.filter(t => t.market === m.slug && t.status === 'OPEN')) {
          t.status = 'SETTLED'; t.settledAt = m.resolvedAt; t.result = m.result;
          t.payout = (t.side === 'UP' ? m.result : 1 - m.result) * t.quantity; t.pnl = t.payout - t.totalCost;
        }
        events.push({kind: 'OFFICIAL_SETTLEMENT', market: m.slug, at: m.resolvedAt, result: m.result, source: response.url});
      } catch (e) {if (e.status !== 404) errors.push('Settlement ' + m.slug + ': ' + e.message);}
    }
    const at = C.iso(clock()), last = seconds.at(-1);
    const healthy = !!last && clock() - last.at * 1000 <= cfg.maxSourceAgeSeconds * 1000 && snapshots.length > 0 && model.status === 'PROVISIONAL' && !errors.length;
    if (healthy) state.lastSuccessAt = at;
    const gapSeconds = previous?.collectedAt ? (Date.parse(startedAt) - Date.parse(previous.collectedAt)) / 1000 : null;
    const metrics = C.stats(state, cfg);
    const snapshot = {
      schemaVersion: 1, version: C.VERSION, venue: cfg.venue, mode: 'PAPER_RESEARCH', liveTradingEnabled: false,
      startedAt, collectedAt: at, lastSuccessAt: state.lastSuccessAt, health: healthy ? 'OK' : 'DEGRADED', errors,
      cadence: {scheduledMinutes: 5, guaranteed: false, gapSeconds, missedWindowWarning: gapSeconds > 360},
      config: cfg, model, spot: last ? {price: last.price, at: C.iso(last.at * 1000), source: 'Polymarket US BRTI reference history'} : null,
      priceHistory: seconds.filter(c => c.at >= (last?.at || 0) - 1800).map(c => ({at: C.iso(c.at * 1000), price: c.price})),
      markets: snapshots, stats: metrics, recentTrades: state.trades.slice(-100).reverse(),
      recentWindows: Object.values(state.markets).sort((a, b) => b.endAt.localeCompare(a.endAt)).slice(0, 100),
      sources: {marketData: BASE, prices: secondResponse?.url || null,
        modelTraining: minuteResponse?.url || null, rules: 'https://docs.polymarket.us/trader-guide/crypto-schema'}
    };
    for (const [bucket, candles, key] of [['1S', seconds, 'lastArchivedSecond'], ['1M', minutes, 'lastArchivedMinute']]) {
      const fresh = candles.filter(c => c.at > state[key]);
      const groups = new Map();
      for (const c of fresh) {const date = C.iso(c.at * 1000).slice(0, 10); if (!groups.has(date)) groups.set(date, []); groups.get(date).push(c);}
      for (const [date, samples] of groups) appendGzip(path.join(out, 'prices', date + '-' + bucket + '.jsonl.gz'), {receivedAt: at, bucket, source: 'BRTI', samples});
      if (fresh.length) state[key] = fresh.at(-1).at;
    }
    appendGzip(path.join(out, 'history', at.slice(0, 10) + '.jsonl.gz'), {
      startedAt, collectedAt: at, version: C.VERSION, config: cfg, gapSeconds, errors, model,
      markets: snapshots.map(({description, ...m}) => m), events
    });
    state.lastCollectedAt = at;
    atomic(path.join(out, 'state.json'), state);
    atomic(path.join(out, 'ledger.json'), {schemaVersion: 1, mode: 'PAPER_RESEARCH', generatedAt: at, trades: state.trades});
    atomic(path.join(out, 'latest.json'), snapshot);
    atomic(path.join(out, 'status.json'), {at, health: snapshot.health, lastSuccessAt: state.lastSuccessAt, errors});
    return snapshot;
  } catch (e) {
    atomic(path.join(out, 'status.json'), {at: C.iso(clock()), health: 'FAILED', lastSuccessAt: state?.lastSuccessAt || null, errors: [e.message]});
    throw e;
  } finally {fs.closeSync(lock); fs.unlinkSync(lockPath);}
}
module.exports = {collect, createReader, readJSON, atomic};

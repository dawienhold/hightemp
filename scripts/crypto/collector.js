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
    // The public book endpoint is CDN-cached for about 30 seconds even with
    // Cache-Control: no-cache. A unique quote URL requests a current snapshot;
    // source-time and HTTP-age checks still apply without relaxing the gate.
    if (route.endsWith('/book')) url.searchParams.set('_t', String(clock()));
    const startedAt = C.iso(clock());
    const r = await transport(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      headers: {Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'hightemp-crypto-research/0.2 (github.com/dawienhold/hightemp)'}});
    if (!r.ok) {const e = new Error('HTTP ' + r.status + ' ' + route); e.status = r.status; throw e;}
    const body = await r.text();
    if (body.length > 8e6) throw new Error('Response exceeds research size limit');
    return {data: JSON.parse(body), startedAt, receivedAt: C.iso(clock()), url: url.href, httpAge: r.headers?.get('age') || null};
  };
}
function migrateState(state) {
  if (state.schemaVersion !== 1 || !state.markets || !Array.isArray(state.trades)) throw new Error('Unknown research state; refusing to reset');
  // v0.1 could only create BTC records. Preserve its ledger, forecasts and price
  // watermarks; ETH starts independently with no borrowed data or fit.
  for (const m of Object.values(state.markets)) {
    if (!m.asset) m.asset = 'btc';
    if (!m.indexSymbol) m.indexSymbol = C.ASSETS[m.asset]?.indexSymbol;
  }
  for (const t of state.trades) if (!t.asset) t.asset = state.markets[t.market]?.asset || 'btc';
  state.archivedByAsset ||= {btc: {second: state.lastArchivedSecond || 0, minute: state.lastArchivedMinute || 0}};
  return state;
}
async function collect(root, config, options = {}) {
  const cfg = C.validateConfig(config), clock = options.clock || Date.now;
  const read = options.read || createReader(cfg, global.fetch, clock), wait = options.pause || pause;
  const out = path.join(root, 'docs/data/crypto'), startedAt = C.iso(clock());
  fs.mkdirSync(out, {recursive: true});
  const lockPath = path.join(out, '.collector.lock'), lock = fs.openSync(lockPath, 'wx');
  const errors = [], events = [], markets = [], groups = {};
  let state;
  try {
    state = migrateState(readJSON(path.join(out, 'state.json'), {schemaVersion: 1, version: C.VERSION, startedAt, lastSuccessAt: null, markets: {}, trades: []}));
    const previous = readJSON(path.join(out, 'latest.json'), null);
    await Promise.all(cfg.assets.map(async asset => {
      const g = groups[asset] = {...C.ASSETS[asset], minutes: [], seconds: [], errors: [], model: {asset, version: C.VERSION, status: 'UNAVAILABLE', samples: 0}};
      const to = Math.floor(clock() / 1000);
      const requests = await Promise.allSettled([
        read('/v1/search', {query: asset.toUpperCase() + ' Up or Down', limit: 20, page: 1}),
        read('/v1/asset-prices/history', {assets: 'crypto:' + asset, bucket: 'ASSET_PRICE_BUCKET_1M', from: to - cfg.historyHours * 3600, to}),
        read('/v1/asset-prices/history', {assets: 'crypto:' + asset, bucket: 'ASSET_PRICE_BUCKET_1S', from: to - 3600, to})
      ]);
      const result = (i, label) => {
        if (requests[i].status === 'fulfilled') return requests[i].value;
        g.errors.push(label + ': ' + requests[i].reason.message); return null;
      };
      g.discovery = result(0, 'Market discovery'); g.minuteResponse = result(1, 'Minute history'); g.secondResponse = result(2, 'Reference history');
      if (g.minuteResponse) {
        try {
          g.minutes = C.parseCandles(g.minuteResponse.data, 'ASSET_PRICE_BUCKET_1M', to * 1000, asset);
          g.model = {...C.fitVariance(g.minutes, cfg, clock()), asset,
            ewma: C.ewmaVariance(g.minutes, cfg.ewmaHalfLifeMinutes, cfg.ewmaLookbackMinutes)};
        }
        catch (e) {g.errors.push('Volatility fit: ' + e.message);}
      }
      if (g.secondResponse) {
        try {g.seconds = C.parseCandles(g.secondResponse.data, 'ASSET_PRICE_BUCKET_1S', to * 1000, asset);}
        catch (e) {g.errors.push('Reference samples: ' + e.message);}
      }
      const seen = new Set();
      if (g.discovery) {
        if (!Array.isArray(g.discovery.data.events)) g.errors.push('Discovery schema missing events');
        for (const event of g.discovery.data.events || []) for (const raw of event.markets || []) {
          const m = C.parseMarket({...raw, events: [{slug: event.slug}]});
          if (m?.asset === asset && !seen.has(m.slug) && Date.parse(m.endAt) > clock() && Date.parse(m.startAt) <= clock()) {
            seen.add(m.slug); markets.push(m);
          }
        }
      }
      // Search can lag a fast-rolling window. Instrument identifiers are only
      // discovery probes; typed asset/index/window terms still verify identity.
      for (const horizon of cfg.horizons) {
        const start = Math.floor(clock() / (horizon * 60000)) * horizon * 60000;
        const stamp = C.iso(start), slug = `${g.instrumentPrefix}-${asset}-updown-${horizon}m-${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}z`;
        if (seen.has(slug)) continue;
        try {
          const response = await read('/v1/market/slug/' + slug), m = C.parseMarket(response.data.market);
          if (m?.slug !== slug || m.asset !== asset || Date.parse(m.startAt) !== start) throw new Error('Current-window probe identity mismatch');
          seen.add(slug); markets.push(m);
        } catch (e) {if (e.status !== 404) g.errors.push('Window discovery: ' + e.message);}
      }
    }));
    const snapshots = [];
    markets.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt) || a.asset.localeCompare(b.asset));
    // Discard windows that expired while discovery was running, so an old
    // window cannot crowd a newly opened stream out of the collection limit.
    for (const m of markets.filter(m => Date.parse(m.endAt) > clock()).slice(0, cfg.maximumMarkets)) {
      const g = groups[m.asset];
      const row = {...m, book: null, valuation: null, baseline: null, diagnostics: null, decision: {status: 'WAIT', reasons: ['Waiting for observations'], candidate: null}};
      const saved = state.markets[m.slug] || {...m, firstObservedAt: C.iso(clock())};
      Object.assign(saved, m, {lastObservedAt: C.iso(clock())}); state.markets[m.slug] = saved;
      try {
        const priceTo = Math.floor(clock() / 1000);
        const fresh = await read('/v1/asset-prices/history', {assets: 'crypto:' + m.asset, bucket: 'ASSET_PRICE_BUCKET_1S', from: priceTo - 120, to: priceTo});
        const newest = C.parseCandles(fresh.data, 'ASSET_PRICE_BUCKET_1S', priceTo * 1000, m.asset);
        g.seconds = [...new Map([...g.seconds, ...newest].map(c => [c.at, c])).values()].sort((a, b) => a.at - b.at);
        const first = await read('/v1/markets/' + m.slug + '/book');
        const at = Date.parse(first.receivedAt), book = C.parseBook(first.data, m.slug, first.receivedAt);
        if (Number(first.httpAge) > cfg.maxSourceAgeSeconds) book.usable = false;
        const value = C.valueMarket(m, g.model, g.seconds, at), baseline = C.valueMarket(m, g.model, g.seconds, at, g.model.baselineVariance);
        const diagnostics = C.modelDiagnostics(m, g.model, g.seconds, at, value, baseline);
        Object.assign(row, {book, valuation: value, baseline, diagnostics, decision: C.decision(m, book, value, g.model, at, cfg), sampledAt: first.receivedAt});
        Object.assign(saved, m, {lastObservedAt: first.receivedAt});
        if (!saved.forecast && value && baseline && m.active && m.status === 'MARKET_STATUS_OPEN' && g.model.status === 'PROVISIONAL' &&
            at - Date.parse(value.sourceAt) <= cfg.maxSourceAgeSeconds * 1000 && m.rulesVerified) {
          saved.forecast = {asset: m.asset, pUp: value.pUp, baselinePUp: baseline.pUp, ewmaPUp: diagnostics.ewma?.pUp ?? null,
            probabilitySpread: diagnostics.probabilitySpread, at: value.calculatedAt, sourceAt: value.sourceAt,
            modelVersion: C.VERSION, minutesRemaining: (Date.parse(m.endAt) - at) / 60000};
        }
        state.markets[m.slug] = saved;
        if (row.decision.candidate && !state.trades.some(t => t.market === m.slug)) {
          await wait(cfg.simulatedLatencyMs);
          const next = await read('/v1/markets/' + m.slug + '/book'), nextAt = Date.parse(next.receivedAt);
          const nextBook = C.parseBook(next.data, m.slug, next.receivedAt);
          if (Number(next.httpAge) > cfg.maxSourceAgeSeconds || nextAt - at < cfg.simulatedLatencyMs) nextBook.usable = false;
          const d = C.decision(m, nextBook, value, g.model, nextAt, cfg);
          if (d.candidate?.side !== row.decision.candidate.side) d.candidate = null;
          const trade = C.openPaperTrade(state, m, d, nextAt, cfg, first.receivedAt);
          if (trade) {
            trade.modelComparisonAtSignal = {harPUp: value.pUp, baselinePUp: baseline?.pUp ?? null, ewmaPUp: diagnostics.ewma?.pUp ?? null,
              probabilitySpread: diagnostics.probabilitySpread, directionDisagreement: diagnostics.directionDisagreement};
          }
          row.paperAction = trade ? 'SIMULATED_FILL' : 'NO_FILL';
          if (!trade) row.paperNote = d.candidate ? 'Aggregate exposure cap or available paper cash prevented an entry' : 'The later quote did not preserve the original qualifying edge or freshness';
          events.push({kind: row.paperAction, asset: m.asset, market: m.slug, at: next.receivedAt, laterBook: nextBook, decision: d, trade});
        } else if (state.trades.some(t => t.market === m.slug)) {row.paperAction = 'ALREADY_ENTERED'; row.paperNote = 'One paper position already exists for this contract';}
      } catch (e) {g.errors.push(m.slug + ': ' + e.message); row.decision = {status: 'WAIT', reasons: [e.message], candidate: null};}
      snapshots.push(row);
    }
    for (const asset of cfg.assets) for (const h of cfg.horizons) {
      if (!snapshots.some(m => m.asset === asset && m.horizon === h + 'm')) groups[asset].errors.push('No current ' + h + 'm market returned; no substitute contract used');
    }
    const pending = Object.values(state.markets).filter(m => m.result === undefined && Date.parse(m.endAt) <= clock()).sort((a, b) => (a.lastSettlementCheckAt || '').localeCompare(b.lastSettlementCheckAt || ''));
    for (const m of pending.slice(0, cfg.settlementChecksPerRun)) {
      m.lastSettlementCheckAt = C.iso(clock());
      try {
        const detail = await read('/v1/market/slug/' + m.slug), verified = C.parseMarket(detail.data.market);
        if (!verified || verified.slug !== m.slug || verified.asset !== m.asset || verified.rulesHash !== m.rulesHash) throw new Error('Settlement identity or rules changed');
        m.status = verified.status;
        if (m.status !== 'MARKET_STATUS_RESOLVED') continue;
        const response = await read('/v1/markets/' + m.slug + '/settlement');
        if (!C.settleRecord(m, response.data, clock())) throw new Error('Final binary settlement not confirmed');
        for (const t of state.trades.filter(t => t.market === m.slug && t.status === 'OPEN')) {
          t.status = 'SETTLED'; t.settledAt = m.resolvedAt; t.result = m.result;
          t.payout = (t.side === 'UP' ? m.result : 1 - m.result) * t.quantity; t.pnl = t.payout - t.totalCost;
        }
        events.push({kind: 'OFFICIAL_SETTLEMENT', asset: m.asset, market: m.slug, at: m.resolvedAt, result: m.result, source: response.url});
      } catch (e) {if (e.status !== 404) errors.push('Settlement ' + m.slug + ': ' + e.message);}
    }
    const at = C.iso(clock()), assets = {};
    for (const asset of cfg.assets) {
      const g = groups[asset], last = g.seconds.at(-1);
      const healthy = !!last && clock() - last.at * 1000 <= cfg.maxSourceAgeSeconds * 1000 && g.model.status === 'PROVISIONAL' && !g.errors.length;
      assets[asset] = {symbol: asset, name: g.name, indexSymbol: g.indexSymbol, health: healthy ? 'OK' : 'DEGRADED', errors: g.errors, model: g.model,
        spot: last ? {price: last.price, at: C.iso(last.at * 1000), source: 'Polymarket US ' + g.indexSymbol + ' history'} : null,
        priceHistory: g.seconds.filter(c => c.at >= (last?.at || 0) - 1800).map(c => ({at: C.iso(c.at * 1000), price: c.price})),
        sources: {prices: g.secondResponse?.url || null, modelTraining: g.minuteResponse?.url || null}};
      errors.push(...g.errors.map(e => asset.toUpperCase() + ': ' + e));
      const watermarks = state.archivedByAsset[asset] ||= {second: 0, minute: 0};
      for (const [bucket, candles, key] of [['1S', g.seconds, 'second'], ['1M', g.minutes, 'minute']]) {
        const fresh = candles.filter(c => c.at > watermarks[key]), days = new Map();
        for (const c of fresh) {const date = C.iso(c.at * 1000).slice(0, 10); if (!days.has(date)) days.set(date, []); days.get(date).push(c);}
        for (const [date, samples] of days) appendGzip(path.join(out, 'prices', asset, date + '-' + bucket + '.jsonl.gz'), {receivedAt: at, asset, bucket, source: g.indexSymbol, samples});
        if (fresh.length) watermarks[key] = fresh.at(-1).at;
      }
    }
    const healthy = !errors.length && cfg.assets.every(asset => assets[asset].health === 'OK');
    if (healthy) state.lastSuccessAt = at;
    const gapSeconds = previous?.collectedAt ? (Date.parse(startedAt) - Date.parse(previous.collectedAt)) / 1000 : null;
    const metrics = C.stats(state, cfg), btc = assets.btc;
    const snapshot = {
      schemaVersion: 1, version: C.VERSION, venue: cfg.venue, mode: 'PAPER_RESEARCH', liveTradingEnabled: false,
      startedAt, collectedAt: at, lastSuccessAt: state.lastSuccessAt, health: healthy ? 'OK' : 'DEGRADED', errors,
      cadence: {scheduledMinutes: 5, recoveryTriggers: true, guaranteed: false, gapSeconds, missedWindowWarning: gapSeconds > 360},
      config: cfg, assets, model: btc?.model || assets[cfg.assets[0]].model, spot: btc?.spot || null,
      priceHistory: btc?.priceHistory || [], markets: snapshots, stats: metrics, recentTrades: state.trades.slice(-100).reverse(),
      recentWindows: Object.values(state.markets).sort((a, b) => b.endAt.localeCompare(a.endAt)).slice(0, 100),
      sources: {marketData: BASE, rules: 'https://docs.polymarket.us/trader-guide/crypto-schema'}
    };
    appendGzip(path.join(out, 'history', at.slice(0, 10) + '.jsonl.gz'), {startedAt, collectedAt: at, version: C.VERSION, config: cfg,
      gapSeconds, errors, models: Object.fromEntries(cfg.assets.map(a => [a, groups[a].model])), markets: snapshots.map(({description, ...m}) => m), events});
    state.version = C.VERSION; state.lastCollectedAt = at;
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
module.exports = {collect, createReader, readJSON, atomic, migrateState};

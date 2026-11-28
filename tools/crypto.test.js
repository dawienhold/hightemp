'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('../scripts/crypto/core');
const {collect, createReader, migrateState} = require('../scripts/crypto/collector');
const {needsCollection} = require('../scripts/crypto-freshness');
const cfg = require('../scripts/crypto/config.json');
const at = Date.parse('2026-11-28T03:41:02Z');
function rawMarket() {
  return {slug: 'cpc-btc-updown-5m-2026-11-28-0340z', question: 'BTC Up or Down 5m', active: true, closed: false,
    status: 'MARKET_STATUS_OPEN', feeCoefficient: .095,
    description: '60 BRTI prices are collected. The simple average is used; Up if greater than or equal to the opening value.',
    assetPriceTerms: {marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN', asset: {assetClass: 'ASSET_CLASS_CRYPTO', symbol: 'btc'},
      indexSymbol: 'BRTI', windowStart: '2026-11-28T03:40:00Z', windowEnd: '2026-11-28T03:45:00Z', priceToBeat: {value: '60000', currency: 'USD'}, priceDecimals: 2}};
}
function book(now = at, bid = .19, ask = .2) {
  return C.parseBook({marketData: {marketSlug: rawMarket().slug, state: 'MARKET_STATE_OPEN', transactTime: C.iso(now),
    bids: [{px: {value: bid, currency: 'USD'}, qty: '100'}], offers: [{px: {value: ask, currency: 'USD'}, qty: '100'}]}}, rawMarket().slug, C.iso(now));
}
function history(bucket, now = at, asset = 'btc') {
  const step = bucket === 'ASSET_PRICE_BUCKET_1M' ? 60 : 1, count = step === 60 ? 1000 : 3600;
  const end = Math.floor(now / 1000 / step) * step;
  const base = asset === 'btc' ? 60000 : 1660, volatility = asset === 'btc' ? .0004 : .0008;
  return {series: [{asset: {assetClass: 'ASSET_CLASS_CRYPTO', symbol: asset}, currency: 'USD', bucket,
    candles: Array.from({length: count}, (_, i) => ({timestamp: end - (count - i) * step,
      close: String(step === 60 ? base * Math.exp(volatility * Math.sin(i / 7) + i * .000001) : base + Math.sin(i / 7) * (asset === 'btc' ? 1 : .01)), tickCount: 60}))}]};
}
test('Student-t probabilities match known values, symmetry and tails', () => {
  assert.equal(C.studentCDF(0, 5), .5);
  assert.ok(Math.abs(C.studentCDF(1, 5) - .8183912661754387) < 1e-10);
  assert.ok(Math.abs(C.studentCDF(1, 1) - .75) < 1e-10);
  assert.ok(Math.abs(C.studentCDF(-2, 5) + C.studentCDF(2, 5) - 1) < 1e-12);
  assert.ok(C.studentCDF(-100, 5) < 1e-8);
});
test('market identity requires typed BTC BRTI terms; unknown rules and fees remain unverified', () => {
  const r = rawMarket(); assert.equal(C.parseMarket(r).rulesVerified, true);
  assert.equal(C.parseMarket({...r, feeCoefficient: undefined}).feeCoefficient, null);
  assert.equal(C.parseMarket({...r, description: 'Bitcoin is going up'}).rulesVerified, false);
  assert.equal(C.parseMarket({...r, assetPriceTerms: {...r.assetPriceTerms, indexSymbol: 'SPOT'}}), null);
  assert.equal(C.parseMarket({...r, slug: '../orders'}), null);
  assert.throws(() => C.validateConfig({...cfg, liveTradingEnabled: true}), /paper research only/);
});
test('incomplete candles, zero-tick gap fills and future observations cannot train the model', () => {
  const r = history('ASSET_PRICE_BUCKET_1M');
  r.series[0].candles.push({timestamp: Math.floor(at / 60000) * 60, close: '99999999', tickCount: 1});
  r.series[0].candles[10].tickCount = 0;
  const candles = C.parseCandles(r, 'ASSET_PRICE_BUCKET_1M', at);
  assert.equal(candles.length, 999); assert.ok(candles.at(-1).at + 60 <= at / 1000);
  const fit = C.fitVariance(candles, cfg, at);
  assert.equal(fit.status, 'PROVISIONAL'); assert.ok(fit.minuteVariance > 0);
  assert.ok(fit.samples < 1000 - 15); assert.match(fit.calibration, /Unvalidated/);
  assert.equal(C.fitVariance(candles.slice(-100), cfg, at).status, 'WARMING_UP');
});
test('closing-average covariance uses discrete samples and abstains on a missing elapsed second', () => {
  const m = C.parseMarket(rawMarket()), end = Date.parse(m.endAt), model = {minuteVariance: .00001, degreesOfFreedom: 5};
  const before = end - 120000;
  const first = C.valueMarket(m, model, [{at: before / 1000 - 1, price: 60000}], before);
  assert.ok(Math.abs(first.effectiveSeconds - (61 + 59 * 60 * 119 / (6 * 3600))) < 1e-10);
  const now = end - 30000;
  const seconds = Array.from({length: 30}, (_, i) => ({at: end / 1000 - 60 + i, price: 60000}));
  const value = C.valueMarket(m, model, seconds, now);
  assert.equal(value.observedAverageSamples, 30);
  assert.ok(Math.abs(value.effectiveSeconds - 30 * 31 * 61 / (6 * 3600)) < 1e-10);
  assert.ok(value.standardDeviationUsd < first.standardDeviationUsd);
  assert.ok(value.pUp > .5); // Rounded ties belong to Up.
  assert.equal(C.valueMarket(m, model, seconds.slice(1), now), null);
  assert.equal(C.valueMarket(m, model, seconds, end), null);
});
test('paper sweeps use depth, opposite-side quotes, per-market fees, rounding and reserve', () => {
  const b = book(); b.asks = [{price: .5, quantity: 3.5}, {price: .6, quantity: 6.5}];
  const fill = C.sweep(b, 'UP', .8, .095, cfg);
  assert.equal(fill.quantity, 10); assert.equal(fill.fills.length, 2);
  const fees = Math.ceil((3.5 * .095 * .5 * .5 + 6.5 * .095 * .6 * .4) * 100) / 100;
  assert.ok(Math.abs(fill.totalCost - (3.5 * .5 + 6.5 * .6 + fees + .1)) < 1e-10);
  b.asks[1].price = .79;
  assert.equal(C.sweep(b, 'UP', .8, .095, cfg).quantity, 3.5);
  assert.equal(C.sweep(b, 'UP', .8, null, cfg), null);
  const no = C.sweep(book(at, .8, .9), 'DOWN', .6, .095, cfg);
  assert.ok(Math.abs(no.averagePrice - .2) < 1e-10);
});
test('stale prices, missing fees and close-to-expiry markets never produce a paper candidate', () => {
  const m = C.parseMarket(rawMarket()), v = {pUp: .8, pDown: .2, sourceAt: C.iso(at)}, model = {status: 'PROVISIONAL'};
  assert.equal(C.decision(m, book(), v, model, at, cfg).status, 'PAPER_CANDIDATE');
  assert.equal(C.decision(m, book(at - 16000), v, model, at, cfg).status, 'WAIT');
  assert.equal(C.decision({...m, feeCoefficient: null}, book(), v, model, at, cfg).status, 'WAIT');
  assert.equal(C.decision(m, book(), v, model, Date.parse(m.endAt) - 1000, cfg).status, 'WAIT');
});
test('paper ledger prevents duplicate entries and limits combined exposure', () => {
  const state = {trades: []}, m = C.parseMarket(rawMarket()), candidate = C.sweep(book(), 'UP', .8, .095, cfg);
  const d = {candidate}; assert.ok(C.openPaperTrade(state, m, d, at, cfg, C.iso(at)));
  assert.equal(C.openPaperTrade(state, m, d, at, cfg, C.iso(at)), null);
  assert.equal(C.openPaperTrade(state, {...m, slug: 'another-market'}, {candidate: {...candidate, totalCost: 31}}, at, cfg, C.iso(at)), null);
});
test('only an official resolved binary settlement grades a forecast or paper trade', () => {
  const m = C.parseMarket(rawMarket());
  assert.equal(C.settleRecord(m, {slug: m.slug, settlement: 1}, at), false);
  m.status = 'MARKET_STATUS_RESOLVED';
  assert.equal(C.settleRecord(m, {slug: 'wrong', settlement: 1}, at), false);
  assert.equal(C.settleRecord(m, {slug: m.slug, settlement: .5}, at), false);
  assert.equal(C.settleRecord(m, {slug: m.slug, settlement: 0}, at), true);
  const state = {markets: {[m.slug]: {...m, forecast: {pUp: .8, baselinePUp: .5}}}, trades: []};
  const s = C.stats(state, cfg); assert.ok(Math.abs(s.brier - .64) < 1e-10); assert.equal(s.baselineBrier, .25);
});
test('reader refuses trading endpoints before performing any network request', async () => {
  let count = 0; const read = createReader(cfg, async () => {count++;});
  await assert.rejects(read('/v1/orders'), /Non-research endpoint/); assert.equal(count, 0);
  await assert.rejects(read('/v1/markets/slug/invalid-plural-route'), /Non-research endpoint/); assert.equal(count, 0);
});
test('collector preserves later-book fills, idempotency, price archives and official settlement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-collector-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let now = at, resolved = false, bookRequests = 0;
  const raw = rawMarket();
  const read = async (route, query) => {
    now += 10; let data;
    if (route === '/v1/search') data = {events: [{slug: raw.slug.replace(/^cpc-/, ''), markets: [raw]}]};
    else if (route === '/v1/asset-prices/history') data = history(query.bucket, now);
    else if (route.endsWith('/book')) {
      bookRequests++;
      data = {marketData: {marketSlug: raw.slug, state: 'MARKET_STATE_OPEN', transactTime: C.iso(now),
        bids: [{px: {value: .19, currency: 'USD'}, qty: '100'}], offers: [{px: {value: bookRequests % 2 ? .2 : .21, currency: 'USD'}, qty: '100'}]}};
    } else if (route === '/v1/market/slug/' + raw.slug) data = {market: {...raw, status: resolved ? 'MARKET_STATUS_RESOLVED' : raw.status}};
    else if (route.startsWith('/v1/market/slug/')) {const e = new Error('Missing mock market'); e.status = 404; throw e;}
    else if (route.endsWith('/settlement')) data = {slug: raw.slug, settlement: 1};
    else throw new Error('Unexpected mock endpoint ' + route);
    return {data, startedAt: C.iso(now), receivedAt: C.iso(now), url: 'https://gateway.polymarket.us' + route};
  };
  const opts = {read, clock: () => now, pause: async ms => {now += ms;}}, btcCfg = {...cfg, assets: ['btc']};
  const first = await collect(root, btcCfg, opts);
  assert.equal(first.stats.openTrades, 1); assert.ok(bookRequests >= 2);
  assert.ok(Math.abs(first.recentTrades[0].averagePrice - .21) < 1e-12);
  const second = await collect(root, btcCfg, opts); assert.equal(second.stats.openTrades, 1);
  resolved = true; now = Date.parse(raw.assetPriceTerms.windowEnd) + 60000;
  const third = await collect(root, btcCfg, opts);
  assert.equal(third.stats.settledTrades, 1); assert.equal(third.stats.scoredMarkets, 1);
  assert.ok(third.stats.realizedPnl > 0); assert.equal(third.stats.openExposure, 0);
  const log = zlib.gunzipSync(fs.readFileSync(path.join(root, 'docs/data/crypto/history/2026-11-28.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 3); assert.ok(log[0].events.some(e => e.kind === 'SIMULATED_FILL'));
  assert.ok(log[2].events.some(e => e.kind === 'OFFICIAL_SETTLEMENT'));
  assert.ok(!fs.existsSync(path.join(root, 'docs/data/crypto/.collector.lock')));
});
test('malformed persisted state is not reset and the collector releases its lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-bad-state-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const out = path.join(root, 'docs/data/crypto'); fs.mkdirSync(out, {recursive: true}); fs.writeFileSync(path.join(out, 'state.json'), '{');
  await assert.rejects(collect(root, cfg));
  assert.equal(fs.readFileSync(path.join(out, 'state.json'), 'utf8'), '{'); assert.ok(!fs.existsSync(path.join(out, '.collector.lock')));
});

function streamMarket(asset, horizon, now = at) {
  const r = rawMarket(), spec = C.ASSETS[asset], start = Math.floor(now / (horizon * 60000)) * horizon * 60000;
  const stamp = C.iso(start);
  r.slug = `${spec.instrumentPrefix}-${asset}-updown-${horizon}m-${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}z`;
  r.question = asset.toUpperCase() + ' Up or Down ' + horizon + 'm';
  r.description = `60 ${spec.indexSymbol} prices are collected. The simple average is used; Up if greater than or equal to the opening value.`;
  r.assetPriceTerms = {...r.assetPriceTerms, indexSymbol: spec.indexSymbol, asset: {assetClass: 'ASSET_CLASS_CRYPTO', symbol: asset},
    windowStart: C.iso(start), windowEnd: C.iso(start + horizon * 60000), priceToBeat: {value: asset === 'btc' ? '60000' : '1660', currency: 'USD'}};
  return r;
}
test('ETH uses its own verified index and cannot consume BTC candles or a BTC model', () => {
  const raw = streamMarket('eth', 5), m = C.parseMarket(raw);
  assert.equal(m.asset, 'eth'); assert.equal(m.indexSymbol, 'ETHUSD_RTI'); assert.equal(m.rulesVerified, true);
  assert.match(m.url, /\/event\/eth-updown/);
  assert.equal(C.parseMarket({...raw, assetPriceTerms: {...raw.assetPriceTerms, indexSymbol: 'BRTI'}}), null);
  assert.throws(() => C.parseCandles(history('ASSET_PRICE_BUCKET_1M'), 'ASSET_PRICE_BUCKET_1M', at, 'eth'), /ETH reference history/);
  const btcModel = {asset: 'btc', minuteVariance: .001, degreesOfFreedom: 5};
  assert.equal(C.valueMarket(m, btcModel, [{at: at / 1000 - 1, price: 1660}], at), null);
  assert.throws(() => C.validateConfig({...cfg, assets: ['btc', 'unknown']}), /Invalid research assets/);
  assert.throws(() => C.validateConfig({...cfg, maximumMarkets: 3}), /every configured stream/);
});
test('legacy BTC forecasts, trades and archive watermarks migrate without resetting', () => {
  const legacy = {schemaVersion: 1, lastArchivedSecond: 123, lastArchivedMinute: 120,
    markets: {old: {slug: 'old', horizon: '5m', forecast: {pUp: .8}, result: 1}},
    trades: [{market: 'old', status: 'OPEN', totalCost: 3}]};
  const state = migrateState(legacy);
  assert.equal(state.markets.old.asset, 'btc'); assert.equal(state.markets.old.forecast.pUp, .8);
  assert.equal(state.trades[0].asset, 'btc'); assert.equal(state.trades[0].totalCost, 3);
  assert.deepEqual(state.archivedByAsset.btc, {second: 123, minute: 120}); assert.equal(state.archivedByAsset.eth, undefined);
});
test('recovery retries overdue or failed collection and skips fresh four-stream data', () => {
  const s = {collectedAt: C.iso(at), health: 'OK', assets: {btc: {}, eth: {}}};
  assert.equal(needsCollection(s, null, at + 1000, 'workflow_run'), false);
  assert.equal(needsCollection(s, null, at + 240000, 'workflow_run'), true);
  assert.equal(needsCollection(s, {health: 'FAILED'}, at + 1000, 'workflow_run'), true);
  assert.equal(needsCollection(s, null, at + 1000, 'push'), true);
  assert.equal(needsCollection({...s, assets: undefined}, null, at + 1000, 'schedule'), true);
  assert.equal(needsCollection(s, null, at - 1000, 'schedule'), true);
});
test('BTC and ETH 5m/15m collect, trade and settle independently under one paper account', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-four-streams-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let now = at, resolved = false;
  const raw = cfg.assets.flatMap(a => cfg.horizons.map(h => streamMarket(a, h))), bySlug = new Map(raw.map(m => [m.slug, m]));
  const priceRequests = [], detailRequests = [];
  const read = async (route, query) => {
    now += 10; let data;
    if (route === '/v1/search') {
      const asset = query.query.split(' ')[0].toLowerCase();
      // Omit BTC 15m to exercise the verified current-window fallback.
      data = {events: raw.filter(m => m.assetPriceTerms.asset.symbol === asset && !(asset === 'btc' && C.parseMarket(m).horizon === '15m')).map(m => ({slug: C.parseMarket(m).eventSlug, markets: [m]}))};
    } else if (route === '/v1/asset-prices/history') {
      const asset = query.assets.split(':')[1]; priceRequests.push(asset); data = history(query.bucket, now, asset);
    } else if (route.startsWith('/v1/market/slug/')) {
      const slug = route.split('/').at(-1), m = bySlug.get(slug); detailRequests.push(slug);
      if (!m) {const e = new Error('Not listed'); e.status = 404; throw e;}
      data = {market: {...m, status: resolved ? 'MARKET_STATUS_RESOLVED' : m.status}};
    } else {
      const slug = route.split('/')[3], m = bySlug.get(slug);
      if (!m) throw new Error('Unexpected market ' + slug);
      if (route.endsWith('/settlement')) data = {slug, settlement: 1};
      else data = {marketData: {marketSlug: slug, state: 'MARKET_STATE_OPEN', transactTime: C.iso(now),
        bids: [{px: {value: .19, currency: 'USD'}, qty: '100'}], offers: [{px: {value: .2, currency: 'USD'}, qty: '100'}]}};
    }
    return {data, startedAt: C.iso(now), receivedAt: C.iso(now), url: 'https://gateway.polymarket.us' + route};
  };
  const opts = {read, clock: () => now, pause: async ms => {now += ms;}};
  const first = await collect(root, cfg, opts);
  assert.equal(first.markets.length, 4); assert.equal(first.stats.openTrades, 4);
  assert.equal(first.stats.streams.length, 4); assert.ok(first.stats.openExposure <= cfg.paperMaxExposureUsd);
  assert.equal(first.assets.btc.model.asset, 'btc'); assert.equal(first.assets.eth.model.asset, 'eth');
  assert.ok(first.assets.eth.model.minuteVariance > first.assets.btc.model.minuteVariance * 2);
  assert.ok(detailRequests.some(slug => slug.includes('btc-updown-15m')));
  assert.ok(priceRequests.includes('eth') && priceRequests.includes('btc'));
  for (const a of cfg.assets) assert.ok(fs.readdirSync(path.join(root, 'docs/data/crypto/prices', a)).some(p => p.endsWith('-1S.jsonl.gz')));
  await collect(root, cfg, opts);
  resolved = true; now = Date.parse('2026-11-28T03:46:00Z');
  const settled = await collect(root, cfg, opts);
  assert.equal(settled.stats.settledTrades, 4); assert.equal(settled.stats.scoredMarkets, 4);
  assert.ok(settled.stats.streams.every(s => s.scoredMarkets === 1 && s.settledTrades === 1));
});
test('ETH failure is reported without substituting BTC prices or stopping BTC records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-partial-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let now = at;
  const raws = [streamMarket('btc', 5), streamMarket('btc', 15)];
  const read = async (route, query) => {
    now += 5; let data;
    if (query?.assets === 'crypto:eth') throw new Error('ETH unavailable');
    if (route === '/v1/search') data = {events: raws.map(m => ({slug: C.parseMarket(m).eventSlug, markets: [m]}))};
    else if (route === '/v1/asset-prices/history') data = history(query.bucket, now);
    else if (route.startsWith('/v1/market/slug/')) {const e = new Error('Not found'); e.status = 404; throw e;}
    else {const slug = route.split('/')[3]; data = {marketData: {marketSlug: slug, state: 'MARKET_STATE_OPEN', transactTime: C.iso(now),
      bids: [{px: {value: .49, currency: 'USD'}, qty: '100'}], offers: [{px: {value: .51, currency: 'USD'}, qty: '100'}]}};}
    return {data, startedAt: C.iso(now), receivedAt: C.iso(now), url: 'https://gateway.polymarket.us' + route};
  };
  const s = await collect(root, cfg, {read, clock: () => now, pause: async ms => {now += ms;}});
  assert.equal(s.assets.eth.spot, null); assert.equal(s.assets.eth.model.status, 'UNAVAILABLE');
  assert.equal(s.markets.filter(m => m.asset === 'btc').length, 2); assert.ok(s.errors.some(e => e.startsWith('ETH:')));
  assert.ok(s.stats.streams.filter(s => s.asset === 'btc').every(s => s.forecastWindows === 1));
});

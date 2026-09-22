'use strict';
// Pure, dependency-free paper-trading logic. No network or order functions here.
const crypto = require('node:crypto');
const U = 1000000;
const STATIONS = Object.freeze({
  KNYC: { cli: 'NYC', offset: -5, tz: 'America/New_York', name: 'Central Park' },
  KMIA: { cli: 'MIA', offset: -5, tz: 'America/New_York', name: 'Miami International' },
  KMDW: { cli: 'MDW', offset: -6, tz: 'America/Chicago', name: 'Chicago Midway' },
  KLAX: { cli: 'LAX', offset: -8, tz: 'America/Los_Angeles', name: 'Los Angeles International' },
  KSFO: { cli: 'SFO', offset: -8, tz: 'America/Los_Angeles', name: 'San Francisco International' }
});
const MONTHS = 'JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER'.split(' ');
const iso = n => new Date(n).toISOString();
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const finite = n => typeof n === 'number' && Number.isFinite(n);
function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + 'T00:00:00Z')) && iso(Date.parse(s + 'T00:00:00Z')).slice(0, 10) === s;
}
function day(ms, station) { return iso(ms + STATIONS[station].offset * 3600000).slice(0, 10); }
function addDay(d, n) { return iso(Date.parse(d + 'T12:00:00Z') + n * 86400000).slice(0, 10); }
function dayStart(d, station) { return Date.parse(d + 'T00:00:00Z') - STATIONS[station].offset * 3600000; }
// USD is an integer number of microdollars throughout sizing and cost calculations.
function units(v) {
  const s = String(v);
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error('Invalid nonnegative USD decimal: ' + s);
  const [a, b = ''] = s.split('.');
  const n = Number(a) * U + Number(b.padEnd(6, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('USD amount too large');
  return n;
}
const dollars = n => n / U;
function halfEven(n, d) { // Exact rational rounding, ties to even.
  const q = n / d, r = n % d;
  return q + (r * 2n > d || (r * 2n === d && q % 2n === 1n) ? 1n : 0n);
}
function feesU(fills, theta) {
  const t = BigInt(units(theta)), s = BigInt(U);
  const numerator = fills.reduce((v, f) => v + t * BigInt(f.qty) * BigInt(f.priceU) * (s - BigInt(f.priceU)) * 100n, 0n);
  // Published cumulative banker-rounded cap. Aggregated depth cannot expose per-fill fee adjustments.
  return Number(halfEven(numerator, s * s * s)) * 10000;
}
function validateConfig(c) {
  if (c.mode !== 'PAPER_ONLY' || c.venue !== 'POLYMARKET_US') throw new Error('Only PAPER_ONLY / POLYMARKET_US is implemented');
  if (c.enabled !== true && c.enabled !== false) throw new Error('enabled must be boolean');
  if (!Array.isArray(c.stations) || !c.stations.length || c.stations.some(s => !STATIONS[s])) throw new Error('Invalid station list');
  if (new Set(c.stations).size !== c.stations.length) throw new Error('Duplicate station');
  for (const k of ['maxNoPrice','priceBuffer','paperStartingCash','maxPaperSpendPerMarket','maxPaperSpendPerStationDay','maxPaperSpendPerUtcDay','feeCoefficient']) units(c[k]);
  if (units(c.maxNoPrice) >= U || units(c.maxNoPrice) <= 0 || units(c.priceBuffer) >= U) throw new Error('Invalid price settings');
  if (!(c.pollSeconds >= 60 && c.pollSeconds <= 600)) throw new Error('pollSeconds must be 60..600');
  if (!(c.sessionSeconds >= 0 && c.sessionSeconds <= 240)) throw new Error('sessionSeconds must be 0..240');
  if (!(c.depthPercent > 0 && c.depthPercent <= 100 && Number.isInteger(c.depthPercent))) throw new Error('Invalid depthPercent');
  if (units(c.feeCoefficient) > U) throw new Error('Invalid fee coefficient');
  for (const k of ['discoverySeconds','cliRefreshSeconds','maxWeatherCheckAgeSeconds','maxBookAgeSeconds','feeReviewAfterDays','bookArchiveLevels'])
    if (!finite(c[k]) || c[k] <= 0) throw new Error('Invalid configuration field: '+k);
  if (!(c.minNetRoi >= 0 && c.minNetRoi <= 1)) throw new Error('Invalid minNetRoi');
  if (!(c.minExecutionDelaySeconds >= 1 && c.maxConfirmationGapSeconds >= c.minExecutionDelaySeconds)) throw new Error('Invalid execution delay');
  if (!(c.discoveryMaxPages >= 1 && c.discoveryMaxPages <= 10 && c.discoveryPageSize >= 1 && c.discoveryPageSize <= 100)) throw new Error('Invalid discovery limits');
  if (!(c.maxMarketsPerCycle >= 1 && c.maxMarketsPerCycle <= 100 && c.maxRequestSeconds >= 2 && c.maxRequestSeconds <= 30)) throw new Error('Invalid request limits');
  if (!validDate(c.feeScheduleReviewedOn)) throw new Error('Invalid fee review date');
  if (!Array.isArray(c.eventSlugs) || c.eventSlugs.some(x => !/^[a-z0-9-]+$/.test(x))) throw new Error('Invalid event slug list');
  return c;
}
function feeIssue(c, now) {
  return now - Date.parse(c.feeScheduleReviewedOn + 'T00:00:00Z') > c.feeReviewAfterDays * 86400000
    ? 'Fee schedule review overdue; observations continue but paper entries paused' : null;
}
function text(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim(); }
function datesIn(s) {
  const out = new Set((s.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || []).filter(validDate));
  for (const m of s.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    const d = `${m[3]}-${String(MONTHS.indexOf(m[1].toUpperCase()) + 1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    if (validDate(d)) out.add(d);
  }
  return [...out];
}
function parseBand(s) {
  s = text(s);
  if (/\d+\.\d+/.test(s)) return null; // Whole-degree contracts only; never parse fragments of decimals.
  const unit = '(?:\\s*(?:°\\s*)?F(?:ahrenheit)?\\b)?';
  const found = [];
  for (const re of [new RegExp('\\bbetween\\s+(-?\\d+)' + unit + '\\s+and\\s+(-?\\d+)' + unit, 'gi'),
    new RegExp('(-?\\d+)' + unit + '\\s*(?:to|-)\\s*(-?\\d+)' + unit + '(?!\\d|\\s*-\\s*\\d)', 'gi')]) {
    for (const m of s.matchAll(re)) {
      // Never interpret pieces of ISO dates as a temperature range.
      if (s.slice(Math.max(0,m.index-5), m.index + m[0].length+5).match(/20\d{2}-\d{2}-\d{2}/)) continue;
      const low = Number(m[1]), high = Number(m[2]);
      if (low >= -100 && high <= 150 && low <= high) found.push({low, high});
    }
  }
  for (const m of s.matchAll(new RegExp('(-?\\d+)' + unit + '\\s+or\\s+(below|lower|less|above|higher|more)\\b', 'gi'))) {
    const v = Number(m[1]); if (v < -100 || v > 150) continue;
    found.push(/below|lower|less/i.test(m[2]) ? {low:null, high:v} : {low:v, high:null});
  }
  const unique = [...new Map(found.map(b => [JSON.stringify(b), b])).values()];
  return unique.length === 1 ? unique[0] : null;
}
function parseMarket(m, event, now) {
  const question = text(m.question || m.title), own = text([question, m.description].join(' '));
  const rules = text([own, event.description, event.resolutionSource, m.rulesDisclaimer].join(' '));
  const issues = [];
  const stations = [...new Set(rules.match(/\bK[A-Z]{3}\b/g) || [])];
  const station = stations.length === 1 && STATIONS[stations[0]] ? stations[0] : null;
  if (!station) issues.push('Exact supported station not unambiguously identified in rules');
  const dates = datesIn(own).length ? datesIn(own) : datesIn(text(event.description));
  const date = dates.length === 1 ? dates[0] : null;
  if (!date) issues.push('One explicit contract date including year required in question/rules');
  if (date && station && (date < addDay(day(now, station), -7) || date > addDay(day(now, station), 1))) issues.push('Contract date outside observation window');
  if (!/(?:highest|maximum|daily\s+high)\s+(?:recorded\s+)?temperature|temperature\s+(?:high|maximum)/i.test(rules)) issues.push('Not a supported daily maximum temperature market');
  if (/lowest\s+temperature|minimum\s+temperature/i.test(question)) issues.push('Low-temperature market rejected');
  if (!/National Weather Service|\bNWS\b/i.test(rules) || !/Climatological Report\s*\(?\s*Daily|Daily Climate Report|\bCLI(?:NYC|MIA|MDW|LAX|SFO)?\b/i.test(rules)) issues.push('NWS daily CLI resolution source not established');
  if (!/\bFahrenheit\b|°\s*F\b|\d\s*F\b/i.test(rules) || /\bCelsius\b|°\s*C\b/i.test(rules)) issues.push('Unambiguous Fahrenheit units required');
  const band = parseBand(question) || parseBand(own);
  if (!band) issues.push('Unsupported or ambiguous temperature band');
  let outcomes = m.outcomes;
  if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
  const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
  const longSide = sides.find(s => s.long === true);
  const shortSide = sides.find(s => s.long === false);
  const yesNo = Array.isArray(outcomes) && outcomes.length === 2 && /^yes$/i.test(outcomes[0]) && /^no$/i.test(outcomes[1]);
  const explicitSides = longSide && shortSide && /^yes$/i.test(text(longSide.description)) && /^no$/i.test(text(shortSide.description));
  if (!yesNo && !explicitSides) issues.push('Affirmative YES / negative NO orientation unverified');
  if (longSide && /^no$/i.test(text(longSide.description))) issues.push('Contradictory long-side orientation');
  if (!/^[a-z0-9-]+$/.test(m.slug || '')) issues.push('Invalid market slug');
  const digest = hash({question, rules, station, date, band, outcomes, sides: sides.map(s => ({long:s.long, description:s.description}))});
  return {slug:m.slug || '', eventSlug:event.slug || '', question, rules, rulesHash:digest,
    station, date, band, valid:issues.length === 0, issues,
    active:m.active === true && m.closed === false && m.archived !== true && event.closed !== true,
    closed:m.closed === true, status:m.status || '',
    minimumQty: finite(m.minimumTradeQty) ? m.minimumTradeQty : 1,
    feeCoefficient:m.feeCoefficient ?? null,
    url:'https://polymarket.us/event/' + encodeURIComponent(event.slug || ''),
    checkedAt:iso(now)};
}
function parseCLI(product, station, receivedAt) {
  const t = String(product.productText || '').replace(/\r/g, '');
  const st = STATIONS[station];
  if (!st || !new RegExp('\\bCLI' + st.cli + '\\b').test(t)) return null;
  const md = t.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
  if (!md || !MONTHS.includes(md[1].toUpperCase())) return null;
  const date = `${md[3]}-${String(MONTHS.indexOf(md[1].toUpperCase())+1).padStart(2,'0')}-${md[2].padStart(2,'0')}`;
  if (!validDate(date)) return null;
  const section = t.split(/TEMPERATURE\s*\(F\)/i)[1];
  if (!section) return null;
  const max = section.split(/PRECIPITATION/i)[0].match(/^\s*MAXIMUM\s+(-?\d+)(?:\s|$)/m);
  const issued = Date.parse(product.issuanceTime);
  if (!max || !finite(issued) || issued > receivedAt || issued < dayStart(date, station) || +max[1] < -100 || +max[1] > 150) return null;
  const partial = /VALID\s+(?:TODAY\s+)?AS\s+OF/i.test(t);
  const final = !partial && issued >= dayStart(addDay(date,1), station);
  return {id: hash([station,product.id,t]), key:`${station}|${date}|CLI`, station, date,
    kind:final ? 'CLI_FINAL' : 'CLI_PRELIMINARY', floorF:+max[1],
    issuedAt:iso(issued), observedAt:null, receivedAt:iso(receivedAt),
    productId:product.id, sourceUrl:'https://api.weather.gov/products/' + encodeURIComponent(product.id || ''),
    asOfText:(t.match(/VALID[^\n]*AS\s+OF[^\n]*/i) || [null])[0],
    corrected:/\bCORRECTED\b|\bCOR\b/.test(t), raw:t};
}
function parseMetar(o, receivedAt) {
  const raw = String(o.rawOb || '');
  const m = raw.match(/^(?:(?:METAR|SPECI)\s+)?(K[A-Z]{3})\s+(\d{2})(\d{2})(\d{2})Z\b/);
  if (!m || !STATIONS[m[1]]) return [];
  const station = m[1], time = Number(o.obsTime) * 1000;
  if (!finite(time) || time > receivedAt || receivedAt - time > 48*3600000) return [];
  const dt = new Date(time);
  if (dt.getUTCDate() !== +m[2] || dt.getUTCHours() !== +m[3] || dt.getUTCMinutes() !== +m[4] || (o.icaoId && o.icaoId !== station)) return [];
  const remarks = raw.split(/\bRMK\b/)[1]; if (!remarks) return [];
  const out = [];
  const common = {station, receivedAt:iso(receivedAt), observedAt:iso(time), issuedAt:null,
    sourceUrl:'https://aviationweather.gov/api/data/metar?ids=' + station + '&format=json&hours=30', raw};
  const tg = remarks.match(/(?:^|\s)T([01])(\d{3})[01]\d{3}(?:\s|$)/);
  if (tg) {
    const c = (tg[1] === '1' ? -1 : 1) * +tg[2] / 10;
    out.push({...common, id:hash(raw+'|T'), key:`${station}|${iso(time)}|T`, date:day(time,station),
      kind:'HOURLY_ADVISORY', temperatureF:c*1.8+32, floorF:null});
  }
  const six = remarks.match(/(?:^|\s)1([01])(\d{3})(?:\s|$)/);
  if (six) {
    const c = (six[1] === '1' ? -1 : 1) * +six[2]/10;
    const syn = Math.round(time / (6*3600000)) * 6*3600000;
    // Use an envelope of actual and nominal synoptic windows. It deliberately
    // rejects a boundary-adjacent window rather than assigning yesterday's peak to today.
    const start = Math.min(time, syn) - 6*3600000;
    const end = Math.max(time, syn);
    const date = day(start, station);
    if (Math.abs(time-syn) <= 20*60000 && day(end-1,station) === date) {
      const f = c*1.8+32;
      const floorF = Math.floor(f - 0.09 + 0.5 - 1e-8); // lower end of 0.1C encoding interval
      if (floorF >= -100 && floorF <= 150) out.push({...common, id:hash(raw+'|6'), key:`${station}|${iso(time)}|SIX`,
        date, kind:'ASOS_SIX_HOUR', maxC:c, floorF, windowStart:iso(start), windowEnd:iso(end),
        quantizationMarginF:0.09, caveat:'Conservative extrema-derived floor; not final CLI or exchange settlement'});
    }
  }
  return out;
}
function chooseEvidence(evidence, station, date, now) {
  const all = Object.values(evidence).filter(e => e.station === station && e.date === date && Date.parse(e.receivedAt) <= now);
  const cli = all.filter(e => e.kind.startsWith('CLI_')).sort((a,b) => Date.parse(b.issuedAt)-Date.parse(a.issuedAt))[0];
  const six = all.filter(e => e.kind === 'ASOS_SIX_HOUR');
  const eligible = cli ? [cli,...six] : six;
  if (cli) {
    const before = six.filter(e => Date.parse(e.observedAt) <= Date.parse(cli.issuedAt));
    if (before.some(e => e.floorF > cli.floorF)) return {evidence:cli, conflict:true, reason:'CLI lower than an earlier six-hour floor; manual review required'};
  }
  eligible.sort((a,b) => b.floorF-a.floorF || (a.kind.startsWith('CLI_') ? -1 : 1));
  return {evidence:eligible[0] || null, conflict:false};
}
function price(v) {
  if (!v || v.currency !== 'USD') throw new Error('Book price must be explicitly USD');
  const n = units(v.value);
  if (n < 0 || n > U) throw new Error('Book price outside $0..$1');
  return n;
}
function parseBook(payload, slug, receivedAt, maxAgeSeconds) {
  const b = payload && payload.marketData;
  if (!b || b.marketSlug !== slug || !Array.isArray(b.bids) || !Array.isArray(b.offers)) throw new Error('Unexpected book schema or wrong market slug');
  const asOf = Date.parse(b.transactTime);
  if (!finite(asOf)) throw new Error('Book timestamp missing');
  const levels = rows => {
    const seen = new Set();
    return rows.map(r => {
      const p = price(r.px), q = String(r.qty);
      if (!/^\d+(?:\.\d+)?$/.test(q) || !finite(Number(q)) || Number(q)>1e9) throw new Error('Invalid book quantity');
      if (seen.has(p)) throw new Error('Duplicate aggregate price level'); seen.add(p);
      return {priceU:p, qty:Math.floor(Number(q))}; // Ignore sub-contract liquidity deliberately.
    }).filter(r => r.qty > 0);
  };
  const bids = levels(b.bids).sort((a,b)=>b.priceU-a.priceU);
  const offers = levels(b.offers).sort((a,b)=>a.priceU-b.priceU);
  const reasons = [];
  if (b.state !== 'MARKET_STATE_OPEN') reasons.push('Market book is not OPEN');
  if (asOf > receivedAt) reasons.push('Book timestamp in the future');
  if (receivedAt-asOf > maxAgeSeconds*1000) reasons.push('Book timestamp too old for simulation');
  if (bids.length && offers.length && bids[0].priceU >= offers[0].priceU) reasons.push('Locked/crossed book; not a reliable snapshot');
  // US has one affirmative instrument: buying NO is economically selling YES.
  const noAsks = bids.filter(x => x.priceU > 0 && x.priceU < U).map(x => ({priceU:U-x.priceU, qty:x.qty}));
  return {slug, receivedAt:iso(receivedAt), asOf:iso(asOf), ageSeconds:(receivedAt-asOf)/1000,
    state:b.state, valid:reasons.length===0, reasons, noAsks, bids, offers,
    bestNoAsk:noAsks.length ? dollars(noAsks[0].priceU) : null, stats:b.stats || {},
    hash:hash({bids, offers, asOf:b.transactTime, state:b.state})};
}
function sharedDepth(first, second) {
  const old = new Map(first.map(x => [x.priceU,x.qty]));
  return second.map(x => ({priceU:x.priceU, qty:Math.min(x.qty,old.get(x.priceU)||0)})).filter(x=>x.qty>0);
}
function simulate(levels, maxSpendU, cfg, {stress=true, minimumQty=1}={}) {
  if (!Number.isSafeInteger(maxSpendU) || maxSpendU <= 0) return null;
  const limit = units(cfg.maxNoPrice), buffer = stress ? units(cfg.priceBuffer) : 0;
  const theta = Number(cfg.feeCoefficient);
  const fills = [];
  const total = fs => fs.reduce((n,f)=>n+f.priceU*f.qty,0) + feesU(fs,cfg.feeCoefficient);
  for (const level of levels) {
    const p = level.priceU+buffer;
    const available = Math.floor(level.qty*(stress ? cfg.depthPercent : 100)/100);
    if (p <= 0 || p >= U || p > limit || available <= 0) continue;
    const cost = p/U + theta*(p/U)*(1-p/U);
    if ((1-cost)/cost < cfg.minNetRoi) continue;
    let lo=0, hi=Math.min(available,Math.floor(maxSpendU/p));
    while(lo<hi) {
      const mid=Math.ceil((lo+hi)/2);
      if(total([...fills,{priceU:p,qty:mid}])<=maxSpendU) lo=mid; else hi=mid-1;
    }
    if(lo) fills.push({priceU:p,qty:lo,displayedPriceU:level.priceU});
  }
  const qty=fills.reduce((n,x)=>n+x.qty,0);
  if(qty < Math.max(1,Math.ceil(minimumQty))) return null;
  const notionalU=fills.reduce((n,x)=>n+x.priceU*x.qty,0), feeU=feesU(fills,cfg.feeCoefficient);
  const costU=notionalU+feeU, gainU=qty*U-costU;
  if(gainU/costU < cfg.minNetRoi) return null;
  return {qty,fills,costU,notionalU,feeU,netIfNoWinsU:gainU,roiIfNoWins:gainU/costU,
    averageNoPrice:dollars(notionalU)/qty,feeCoefficient:cfg.feeCoefficient,
    feeModel:'cumulative banker-rounded taker fee estimate; per-fill details unavailable',
    assumption:stress ? 'Delayed two-snapshot shared depth, haircut, adverse price buffer; NOT an executed fill' : 'Displayed-book capacity only; NOT an executable guarantee'};
}
function paperBudget(state, market, cfg, now) {
  const ps=Object.values(state.positions || {});
  const settled=ps.filter(p=>p.exchangeGrade);
  const realized=settled.reduce((n,p)=>n+p.exchangeGrade.netU,0);
  const open=ps.filter(p=>!p.exchangeGrade).reduce((n,p)=>n+p.costU,0);
  const station=ps.filter(p=>p.station===market.station&&p.date===market.date).reduce((n,p)=>n+p.costU,0);
  const utc=iso(now).slice(0,10);
  const daily=ps.filter(p=>p.enteredAt.slice(0,10)===utc).reduce((n,p)=>n+p.costU,0);
  return Math.max(0, Math.min(units(cfg.maxPaperSpendPerMarket),units(cfg.paperStartingCash)+realized-open,
    units(cfg.maxPaperSpendPerStationDay)-station,units(cfg.maxPaperSpendPerUtcDay)-daily));
}
function classify(m, book, selection, cfg, now) {
  if (!m.valid) return {ok:false,reason:'RULES_REVIEW',detail:m.issues.join('; ')};
  if (!m.active) return {ok:false,reason:'MARKET_NOT_ACTIVE'};
  if (m.rulesChanged) return {ok:false,reason:'RULES_CHANGED_REVIEW'};
  if (feeIssue(cfg,now)) return {ok:false,reason:'FEE_REVIEW_REQUIRED'};
  if (m.feeCoefficient != null && Number(m.feeCoefficient) !== Number(cfg.feeCoefficient)) return {ok:false,reason:'MARKET_FEE_DIFFERS_REVIEW'};
  if (!selection.evidence) return {ok:false,reason:'WAITING_FOR_EXTREMA_OR_CLI'};
  if (selection.evidence.station !== m.station || selection.evidence.date !== m.date ||
      !['CLI_FINAL','CLI_PRELIMINARY','ASOS_SIX_HOUR'].includes(selection.evidence.kind))
    return {ok:false,reason:'UNSUPPORTED_OR_MISMATCHED_EVIDENCE'};
  if (selection.conflict) return {ok:false,reason:'WEATHER_CONFLICT',detail:selection.reason};
  if (!finite(m.band.high)) return {ok:false,reason:'UNBOUNDED_UPPER_RANGE'};
  if (selection.evidence.floorF <= m.band.high) return {ok:false,reason:'RANGE_NOT_ELIMINATED'};
  if (!book || !book.valid) return {ok:false,reason:'BOOK_UNUSABLE',detail:book ? book.reasons.join('; ') : 'No current book'};
  if (!book.noAsks.length) return {ok:false,reason:'NO_NO_ASK_LIQUIDITY'};
  return {ok:true,reason:'EVIDENCE_ELIMINATED_NOT_SETTLED'};
}
function evaluate(state, m, book, selection, cfg, now, weatherFresh) {
  state.signals ||= {}; state.positions ||= {}; state.previousBooks ||= {};
  const events=[];
  const result=classify(m,book,selection,cfg,now);
  const e=selection.evidence;
  const key=m.slug;
  if (!state.signals[key] && m.valid && !selection.conflict && e && finite(m.band.high) && e.floorF>m.band.high) {
    state.signals[key]={firstSeenAt:iso(now),evidenceId:e.id,rulesHash:m.rulesHash,firstBookAt:book?.receivedAt||null,
      firstNoAsk:book?.bestNoAsk??null};
    events.push({kind:'ELIMINATION_FIRST_OBSERVED',market:key,...state.signals[key]});
  }
  const before=state.previousBooks[key];
  const quoteCapacity=result.ok ? simulate(book.noAsks,units(cfg.maxPaperSpendPerMarket),cfg,{stress:false,minimumQty:m.minimumQty}) : null;
  let status=result.reason;
  if (state.positions[key]) status='PAPER_POSITION_ALREADY_RECORDED';
  else if(result.ok) {
    if (!weatherFresh) status='WEATHER_REFRESH_STALE';
    else if (!before || !before.valid || before.rulesHash!==m.rulesHash || !before.eliminated) status='WAITING_FOR_LATER_BOOK';
    else {
      const gap=Date.parse(book.receivedAt)-Date.parse(before.receivedAt);
      const sinceSignal=Date.parse(book.receivedAt)-Date.parse(state.signals[key].firstSeenAt);
      if (gap<cfg.minExecutionDelaySeconds*1000 || sinceSignal<cfg.minExecutionDelaySeconds*1000) status='EXECUTION_DELAY_NOT_REACHED';
      else if (gap>cfg.maxConfirmationGapSeconds*1000) status='CONFIRMATION_GAP_TOO_LONG';
      else {
        const shared=sharedDepth(before.noAsks,book.noAsks);
        const fill=simulate(shared,paperBudget(state,m,cfg,now),cfg,{minimumQty:m.minimumQty});
        if(!fill) status='NO_STRESS_QUALIFYING_LIQUIDITY_OR_BUDGET';
        else {
          const position={id:hash(key+'|'+m.rulesHash),market:key,eventSlug:m.eventSlug,question:m.question,
            station:m.station,date:m.date,band:m.band,rulesHash:m.rulesHash,enteredAt:iso(now),
            signalSeenAt:state.signals[key].firstSeenAt,executionObservationDelaySeconds:gap/1000,
            firstQuoteAt:before.receivedAt,secondQuoteAt:book.receivedAt,evidence:{...e,raw:undefined},
            cfgHash:hash(cfg),mode:'PAPER_ONLY',...fill};
          state.positions[key]=position;
          events.push({kind:'PAPER_ENTRY',...position}); status='PAPER_ENTRY_RECORDED';
        }
      }
    }
  }
  if(book) state.previousBooks[key]={valid:book.valid,receivedAt:book.receivedAt,noAsks:book.noAsks,
    rulesHash:m.rulesHash,eliminated:result.ok&&weatherFresh};
  return {status,detail:result.detail || null,quoteCapacity,events,signal:state.signals[key] || null};
}
function gradeCLI(position, evidence) {
  const r=Object.values(evidence).filter(x=>x.station===position.station&&x.date===position.date&&x.kind==='CLI_FINAL')
    .sort((a,b)=>Date.parse(b.issuedAt)-Date.parse(a.issuedAt))[0];
  if(!r) return null;
  const yes=(position.band.low==null||r.floorF>=position.band.low)&&(position.band.high==null||r.floorF<=position.band.high);
  const payoutU=yes?0:position.qty*U;
  return {source:'CLI_CHECK_NOT_EXCHANGE_SETTLEMENT',productId:r.productId,cliMax:r.floorF,noWouldWin:!yes,
    netU:payoutU-position.costU,checkedAt:r.receivedAt,evidenceId:r.id};
}
function gradeExchange(position, payload, market, book, now) {
  // A bare settlement:0 may be a default on an unresolved market. Require finality evidence too.
  if(!payload || payload.slug!==position.market || !finite(payload.settlement) || payload.settlement<0 || payload.settlement>1) return null;
  if(!market || !market.closed || market.rulesHash!==position.rulesHash) return null;
  const finals=new Set(['RESOLVED','SETTLED','MARKET_STATUS_RESOLVED','MARKET_STATUS_SETTLED',
    'MARKET_STATE_RESOLVED','MARKET_STATE_SETTLED']);
  const explicitFinal=finals.has(market.status) || (book && finals.has(book.state));
  if(!explicitFinal || (book && book.stats.settlementPreliminaryFlag===true)) return null;
  const payoutU=Math.round((1-payload.settlement)*U)*position.qty;
  return {source:'EXCHANGE_SETTLEMENT_OBSERVED',yesSettlement:payload.settlement,noPayout:1-payload.settlement,
    netU:payoutU-position.costU,checkedAt:iso(now),alternativeSettlement:payload.settlement!==0&&payload.settlement!==1};
}
module.exports={U,STATIONS,iso,hash,finite,validDate,day,addDay,dayStart,units,dollars,halfEven,feesU,
  validateConfig,feeIssue,text,parseBand,parseMarket,parseCLI,parseMetar,chooseEvidence,parseBook,
  sharedDepth,simulate,paperBudget,classify,evaluate,gradeCLI,gradeExchange};

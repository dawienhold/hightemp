(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const valid = n => n !== null && n !== undefined && Number.isFinite(Number(n));
  const usd = n => valid(n) ? new Intl.NumberFormat(undefined, {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2}).format(n) : '—';
  const pct = n => valid(n) ? (n * 100).toFixed(1) + '%' : '—';
  const modelPct = n => !valid(n) ? '—' : n >= .9995 ? '>99.9%' : n <= .0005 ? '<0.1%' : pct(n);
  const cents = n => valid(n) ? (n * 100).toFixed(1) + '¢' : '—';
  const time = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'}) : '—';
  const dateTime = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '—';
  const score = n => valid(n) ? Number(n).toFixed(4) : '—';
  const set = (id, value) => {$(id).textContent = value;};
  let snapshot = null, selected = '', lastLoadError = null;
  function age(at) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000));
    if (!Number.isFinite(seconds)) return 'time unavailable';
    return seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : Math.floor(seconds / 3600) + 'h ago';
  }
  function el(tag, text, className) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  }
  function row(values) {
    const tr = el('tr');
    for (const v of values) {
      const td = el('td');
      if (v instanceof Node) td.append(v); else td.textContent = v;
      tr.append(td);
    }
    return tr;
  }
  function marketLink(m, label) {
    const a = el('a', label);
    const url = new URL(m.url || 'https://polymarket.us');
    if (url.origin === 'https://polymarket.us') a.href = url.href;
    a.target = '_blank'; a.rel = 'noopener'; return a;
  }
  function emptyTable(id, columns, message) {
    const tr = el('tr'), td = el('td', message, 'empty'); td.colSpan = columns; tr.append(td); $(id).replaceChildren(tr);
  }
  function svgNode(tag, attributes = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text; return node;
  }
  function chart(m) {
    const rows = (snapshot.priceHistory || []).filter(p => valid(p.price) && Number.isFinite(Date.parse(p.at)));
    if (rows.length < 2) { $('price-chart').replaceChildren(el('div', 'No complete BRTI price history is available in this collection.', 'empty')); return; }
    const w = 850, h = 310, left = 12, right = 90, top = 20, bottom = 34;
    const xs = rows.map(p => Date.parse(p.at)), ys = rows.map(p => Number(p.price));
    const reference = m?.referencePrice;
    if (valid(reference)) ys.push(Number(reference));
    const lo = Math.min(...ys), hi = Math.max(...ys), padding = Math.max((hi - lo) * .15, 5);
    const min = lo - padding, max = hi + padding;
    const x = t => left + (t - xs[0]) / (xs.at(-1) - xs[0]) * (w - left - right);
    const y = p => top + (max - p) / (max - min) * (h - top - bottom);
    const svg = svgNode('svg', {viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': 'Recorded BTC BRTI prices and the selected contract reference. Missing observations create breaks in the line.'});
    for (let i = 0; i < 5; i++) {
      const price = min + (max - min) * i / 4, yy = y(price);
      svg.append(svgNode('line', {x1: left, y1: yy, x2: w - right, y2: yy, class: 'gridline'}));
      svg.append(svgNode('text', {x: w - right + 12, y: yy + 4, class: 'axis'}, Math.round(price).toLocaleString()));
    }
    for (let i = 0; i < 4; i++) {
      const t = xs[0] + (xs.at(-1) - xs[0]) * i / 3;
      svg.append(svgNode('text', {x: x(t), y: h - 7, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}, new Date(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})));
    }
    if (valid(reference)) svg.append(svgNode('line', {x1: left, y1: y(reference), x2: w - right, y2: y(reference), class: 'reference-line'}));
    // Retain a break whenever consecutive source seconds are missing. Thinning is
    // for rendering only; the downloadable snapshots retain every observed second.
    const segments = []; let segment = [];
    for (let i = 0; i < rows.length; i++) {
      if (i && xs[i] - xs[i - 1] > 1500) {if (segment.length) segments.push(segment); segment = [];}
      segment.push(rows[i]);
    }
    if (segment.length) segments.push(segment);
    for (const part of segments) {
      const stride = Math.max(1, Math.ceil(part.length / 500));
      const sampled = part.filter((_, i) => i % stride === 0 || i === part.length - 1);
      svg.append(svgNode('path', {d: sampled.map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.at)).toFixed(2)},${y(p.price).toFixed(2)}`).join(' '), class: 'price-line'}));
    }
    const last = rows.at(-1); svg.append(svgNode('circle', {cx: x(xs.at(-1)), cy: y(last.price), r: 3, fill: 'var(--accent)'}));
    $('price-chart').replaceChildren(svg);
  }
  function currentMarket() {return snapshot?.markets?.find(m => m.slug === selected) || snapshot?.markets?.[0] || null;}
  function selectedMarket() {
    const m = currentMarket();
    set('window-title', m ? 'BTC Up or Down · ' + m.horizon : 'BTC reference price');
    set('reference', usd(m?.referencePrice)); set('snapshot-time', time(m?.sampledAt || snapshot.collectedAt));
    set('up-probability', modelPct(m?.valuation?.pUp)); set('down-probability', modelPct(m?.valuation?.pDown));
    $('up-bar').style.width = (valid(m?.valuation?.pUp) ? Math.max(0, Math.min(100, m.valuation.pUp * 100)) : 0) + '%';
    $('down-bar').style.width = (valid(m?.valuation?.pDown) ? Math.max(0, Math.min(100, m.valuation.pDown * 100)) : 0) + '%';
    set('up-cost', 'Buy ask ' + cents(m?.book?.yesAsk) + ' · before fees');
    set('down-cost', 'Buy ask ' + cents(m?.book?.noAsk) + ' · before fees');
    set('model-note', m?.valuation ? 'Provisional estimate at ' + time(m.valuation.calculatedAt) + '. Closing-average uncertainty: ±' + usd(m.valuation.standardDeviationUsd) + ' (1 SD). ' + m.valuation.observedAverageSamples + '/60 closing samples observed.' : 'No probability is calculated without a complete reference and the required BRTI observations.');
    chart(m); tick();
  }
  function tick() {
    if (!snapshot) return;
    const stale = Date.now() - Date.parse(snapshot.collectedAt) > 10 * 60000;
    set('stamp', 'Snapshot ' + age(snapshot.collectedAt));
    set('health-label', lastLoadError ? 'Archive refresh failed' : stale ? 'Collector overdue' : snapshot.health === 'OK' ? 'Scheduled collection active' : 'Collection needs attention');
    const m = currentMarket();
    if (!m) {set('countdown', '—'); set('signal', 'No current eligible BTC contracts were returned in this snapshot.'); return;}
    const seconds = Math.ceil((Date.parse(m.endAt) - Date.now()) / 1000);
    set('countdown', seconds <= 0 ? 'Window ended' : Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
    let message;
    const candidate = m.decision?.candidate;
    if (candidate) message = 'Paper signal at snapshot: ' + candidate.side + ' · ' + cents(candidate.edge) + ' estimated edge/contract after costs.';
    else message = (m.decision?.reasons || ['No paper signal'])[0];
    if (seconds <= 0) message = 'Window ended. Showing the saved forecast and quotes; reload the archive for a newer window.';
    else if (Date.now() - Date.parse(m.sampledAt) > 15000) message = 'Saved snapshot only. ' + message;
    set('signal', message);
    const notes = [...(snapshot.errors || [])];
    if (lastLoadError) notes.unshift(lastLoadError + ' Last loaded data remain visible.');
    if (stale) notes.unshift('No collection in the last 10 minutes. Prices and model values below are stored observations.');
    if (snapshot.cadence?.missedWindowWarning) notes.push('The previous collection gap was ' + Math.round(snapshot.cadence.gapSeconds / 60) + ' minutes; missed windows were not reconstructed.');
    $('notice').className = 'notice' + (!notes.length ? ' good' : '');
    set('notice', notes.length ? notes.join(' ') : 'Research is collecting. Five-minute GitHub snapshots can miss short windows. The model is provisional; all positions and fills are simulated.');
  }
  function render(s) {
    snapshot = s;
    const stats = s.stats || {}, model = s.model || {}, cfg = s.config || {};
    set('btc-price', usd(s.spot?.price)); set('price-stamp', s.spot ? 'BRTI observed ' + time(s.spot.at) : 'Reference feed unavailable');
    set('volatility', valid(model.minuteVariance) && s.spot ? usd(s.spot.price * Math.sqrt(model.minuteVariance)) : '—');
    set('model-label', model.status === 'PROVISIONAL' ? '1 SD · provisional HAR-style model' : model.status || 'Unavailable');
    set('paper-pnl', usd(stats.realizedPnl)); $('paper-pnl').className = stats.realizedPnl < 0 ? 'negative' : stats.realizedPnl > 0 ? 'positive' : '';
    set('paper-count', (stats.settledTrades || 0) + ' settled · ' + (stats.openTrades || 0) + ' open simulated trades');
    set('brier', score(stats.brier)); set('brier-count', (stats.scoredMarkets || 0) + ' resolved forecasts · lower is better');
    for (const [id, key] of [['starting-balance', 'startingBankroll'], ['equity', 'equity'], ['cash', 'availableCash'], ['exposure', 'openExposure'], ['drawdown', 'maxDrawdown']]) set(id, usd(stats[key]));
    set('win-rate', pct(stats.winRate)); set('model-score', score(stats.brier)); set('baseline-score', score(stats.baselineBrier));
    set('resolved-count', stats.scoredMarkets || 0); set('score-count', (stats.scoredMarkets || 0) + ' SCORED WINDOWS');
    const select = $('market-select'), chosen = selected;
    select.replaceChildren();
    for (const m of s.markets || []) {const o = el('option', m.horizon + ' · closes ' + time(m.endAt)); o.value = m.slug; select.append(o);}
    if (!select.options.length) {const o = el('option', 'No current market'); o.value = ''; select.append(o);}
    selected = (s.markets || []).some(m => m.slug === chosen) ? chosen : select.options[0].value; select.value = selected;
    const table = $('markets-body'); table.replaceChildren();
    for (const m of s.markets || []) {
      const name = el('div'); name.append(marketLink(m, m.horizon + ' · ' + time(m.endAt))); name.append(el('small', 'Snapshot ' + time(m.sampledAt)));
      const status = el('div', m.decision?.status === 'PAPER_CANDIDATE' ? 'Paper candidate' : m.decision?.status === 'NO_EDGE' ? 'No qualifying edge' : 'Abstaining');
      status.append(el('small', m.paperAction === 'SIMULATED_FILL' ? 'Simulated fill recorded' : (m.decision?.reasons || []).join('; ')));
      const edge = (p, ask) => valid(p) && valid(ask) && valid(m.feeCoefficient) ? p - ask - m.feeCoefficient * ask * (1 - ask) - cfg.slippageReserve : null;
      const upEdge = edge(m.valuation?.pUp, m.book?.yesAsk), downEdge = edge(m.valuation?.pDown, m.book?.noAsk);
      const edgeLabel = v => (v > 0 ? '+' : '') + cents(v);
      const edges = el('div', 'Up ' + edgeLabel(upEdge)); edges.append(el('small', 'Down ' + edgeLabel(downEdge)));
      table.append(row([name, usd(m.referencePrice), modelPct(m.valuation?.pUp), cents(m.book?.yesAsk), cents(m.book?.noAsk), edges, status]));
    }
    if (!(s.markets || []).length) emptyTable('markets-body', 7, 'No eligible markets in this collection. See collection health below.');
    $('calibration-body').replaceChildren(...(stats.calibration || []).map(b => row([Math.round(b.low * 100) + '–' + Math.round(b.high * 100) + '%', b.n, pct(b.predicted), pct(b.actual)])));
    $('ledger-body').replaceChildren();
    for (const t of s.recentTrades || []) {
      const pnl = el('span', usd(t.pnl), t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : '');
      $('ledger-body').append(row([dateTime(t.enteredAt), t.horizon + ' · ' + time(t.endAt), t.side, Number(t.quantity).toFixed(2), usd(t.totalCost), cents(t.edge), t.status === 'SETTLED' ? 'Settled' : 'Awaiting settlement', pnl]));
    }
    if (!(s.recentTrades || []).length) emptyTable('ledger-body', 8, 'No paper fills yet. A signal requires a fresh model, verified rules, known fees, sufficient depth, and a qualifying later quote.');
    $('export-csv').disabled = false;
    const coverage = [
      ['Collection cadence', 'Every five minutes, best effort. Last observed gap: ' + (valid(s.cadence?.gapSeconds) ? Math.round(s.cadence.gapSeconds) + ' seconds.' : 'first collection.')],
      ['Model sample', (model.samples || 0).toLocaleString() + ' historical one-minute training rows. These do not count as paper trades.'],
      ['Model training period', dateTime(model.trainingFrom) + ' to ' + dateTime(model.trainingThrough)],
      ['Last successful collection', s.lastSuccessAt ? dateTime(s.lastSuccessAt) : 'No fully healthy collection yet'],
      ['Paper entry settings', cfg.paperContractsPerOrder + ' contracts maximum; ' + cents(cfg.minimumEdge) + ' minimum net edge; ' + usd(cfg.paperMaxExposureUsd) + ' aggregate exposure cap.'],
      ['Execution assumptions', cfg.simulatedLatencyMs / 1000 + 's minimum re-quote delay; ' + cents(cfg.slippageReserve) + ' adverse-price reserve per contract; fees from each market.'],
      ['Settlement', 'Official resolved status plus final binary payout. No local spot-price grading.'],
      ['Archive', 'Daily compressed price and quote history; complete paper ledger; source and receipt timestamps retained.']
    ];
    $('coverage').replaceChildren(...coverage.map(([label, text]) => {const d = el('div'); d.append(el('dt', label), el('dd', text)); return d;}));
    set('version', s.version + ' · Live execution disabled'); selectedMarket();
  }
  async function getJSON(url) {
    const r = await fetch(url + '?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  }
  async function load() {
    const button = $('refresh'); button.disabled = true;
    try {
      const [data, status] = await Promise.allSettled([getJSON('data/crypto/latest.json'), getJSON('data/crypto/status.json')]);
      if (data.status !== 'fulfilled') throw new Error('Latest archive unavailable. The collector may not have published its first snapshot.');
      if (data.value.schemaVersion !== 1 || data.value.mode !== 'PAPER_RESEARCH') throw new Error('Unsupported research snapshot');
      lastLoadError = status.status === 'fulfilled' && status.value.health === 'FAILED' ? status.value.errors.join('; ') : null;
      render(data.value);
    } catch (e) {lastLoadError = e.message; if (snapshot) tick(); else {set('notice', e.message); set('health-label', 'Awaiting published data');}}
    finally {button.disabled = false;}
  }
  $('refresh').addEventListener('click', load);
  $('market-select').addEventListener('change', e => {selected = e.target.value; selectedMarket();});
  $('export-csv').addEventListener('click', async () => {
    const b = $('export-csv'); b.disabled = true;
    try {
      const ledger = await getJSON('data/crypto/ledger.json');
      const columns = ['id', 'market', 'horizon', 'signalAt', 'enteredAt', 'endAt', 'side', 'quantity', 'averagePrice', 'fees', 'slippageReserve', 'totalCost', 'edge', 'feeCoefficient', 'status', 'settledAt', 'payout', 'pnl'];
      const quote = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
      const csv = [columns.join(','), ...(ledger.trades || []).map(t => columns.map(k => quote(t[k])).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
      const a = el('a'); a.href = url; a.download = 'crypto-paper-trades.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {set('notice', 'Could not export the paper ledger: ' + e.message);}
    finally {b.disabled = false;}
  });
  load(); setInterval(load, 60000); setInterval(tick, 1000);
})();

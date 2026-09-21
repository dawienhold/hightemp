#!/usr/bin/env node
/* ============================================================================
   One forecast pass, run by GitHub Actions on a schedule.

   Deterministic from end to end: fetch, forecast, settle against the CLI,
   score, write files. Nothing in here depends on a browser, a laptop or a
   language model. Every file it writes lives under docs/data/ and is committed
   by the workflow, so the git history is itself the audit trail.

   Files
     docs/data/latest.json         the dashboard's snapshot (most recent pass)
     docs/data/stats.json          running scorecard accumulators
     docs/data/state.json          settlement queue, regime memory, prior-day
                                   reports, CLI parse cache, morning bookkeeping
     docs/data/status.json         heartbeat: last run, last success, errors
     docs/data/runs.jsonl          one line per run, success or failure
     docs/data/cli.json            every FINAL CLI maximum seen, per station/date
     docs/data/history/YYYY-MM.jsonl   every call every pass made (append-only)
     docs/data/raw/metar/YYYY-MM-DD.txt  raw METAR/SPECI text as received (UTC day)
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "docs", "data");
const F = {
  latest: path.join(DATA, "latest.json"),
  stats:  path.join(DATA, "stats.json"),
  state:  path.join(DATA, "state.json"),
  status: path.join(DATA, "status.json"),
  runs:   path.join(DATA, "runs.jsonl"),
  cli:    path.join(DATA, "cli.json"),
};

const readJSON = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return dflt; } };
const writeJSON = (p, v, pretty) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, pretty ? 1 : 0) + "\n");
  fs.renameSync(tmp, p);                                  // atomic: never a half-written file
};
const appendLine = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + "\n");
};

// ------------------------------------------------------------ persistent state
const state = readJSON(F.state, {});
state.pending   = Array.isArray(state.pending) ? state.pending : [];
state.regime    = state.regime && typeof state.regime === "object" ? state.regime : {};
state.reports   = Array.isArray(state.reports) ? state.reports : [];
state.cliCache  = state.cliCache && typeof state.cliCache === "object" ? state.cliCache : {};

// The engine was written against browser storage. These three keys map onto the
// state file, so the engine's own queue logic runs unchanged.
const LS_MAP = { "ht.pending.v1": "pending", "ht.regime.v1": "regime", "ht.priorday.v1": "reports" };
global.localStorage = {
  getItem(k) { return LS_MAP[k] ? JSON.stringify(state[LS_MAP[k]]) : null; },
  setItem(k, v) { if (LS_MAP[k]) state[LS_MAP[k]] = JSON.parse(v); },
  removeItem(k) { if (LS_MAP[k]) state[LS_MAP[k]] = LS_MAP[k] === "regime" ? {} : []; },
};

const HT = require(path.join(ROOT, "engine", "engine.js"));

// --------------------------------------------------------------- raw archive
const ARCHIVE_IDS = ["KNYC", "KMIA", "KMDW", "KLAX", "KSFO", "KLGA", "KEWR", "KJRB", "KTEB"];
async function archiveMetars() {
  const url = `https://aviationweather.gov/api/data/metar?ids=${ARCHIVE_IDS.join(",")}&format=raw&hours=3`;
  const r = await fetch(url, { headers: { "User-Agent": "hightemp-desk (github.com/dawienhold/hightemp)" },
                               signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("METAR archive HTTP " + r.status);
  const lines = (await r.text()).split("\n").map(s => s.trim()).filter(s => /^(METAR|SPECI)\s+K/.test(s));
  let added = 0;
  const byDay = {};
  for (const ln of lines) {
    const m = ln.match(/^(?:METAR|SPECI)\s+\w{4}\s+(\d{2})(\d{2})(\d{2})Z/);
    if (!m) continue;
    // Resolve the day-of-month against now (a report can be from yesterday UTC).
    const now = new Date();
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +m[1]));
    if (d - now > 2 * 86400e3) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, +m[1]));
    const day = d.toISOString().slice(0, 10);
    (byDay[day] = byDay[day] || []).push(ln);
  }
  for (const [day, arr] of Object.entries(byDay)) {
    const p = path.join(DATA, "raw", "metar", day + ".txt");
    const have = new Set(fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : []);
    const fresh = arr.filter(l => !have.has(l));
    if (fresh.length) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, fresh.join("\n") + "\n");
      added += fresh.length;
    }
  }
  return added;
}

// ------------------------------------------------------------------- the pass
async function main() {
  const t0 = Date.now();
  const now = new Date();
  const etDate = HT.localDate(now, "America/New_York");
  const etHour = HT.localHour(now, "America/New_York");

  const prevStats = readJSON(F.stats, null);
  const prevLatest = readJSON(F.latest, null);
  const status = readJSON(F.status, {});

  // The 7am call: the first pass of the Eastern day at or after 7:00, and only
  // up to 10:00. A pass that first runs at 2pm is NOT passed off as a morning
  // call -- that day's morning is recorded as missed instead.
  const force = String(process.env.FORCE_MORNING || "").toLowerCase() === "true";
  const morning = force || (etHour >= 7 && etHour < 10 && state.lastMorningDate !== etDate);
  if (!morning && etHour >= 10 && state.lastMorningDate !== etDate && state.missedMorning !== etDate) {
    state.missedMorning = etDate;
  }

  const cliCache = new Map(Object.entries(state.cliCache));
  const opts = { maxCurve: 48, cliCache };
  if (morning) { opts.morning = true;  opts.priorMorning = prevLatest && prevLatest.morning || null; }
  else         { opts.morning = false; opts.carryMorning = prevLatest && prevLatest.morning || null; }

  const out = await HT.passAuto(prevStats, opts);
  const snap = out.snap;

  const errors = snap.stations.filter(s => s.error).map(s => `${s.station}: ${s.error}`);
  if (errors.length === snap.stations.length) {
    throw new Error("every station failed: " + errors.join(" | "));
  }

  // A station that failed this pass keeps its last good card, clearly marked,
  // rather than vanishing from the dashboard.
  if (errors.length && prevLatest && Array.isArray(prevLatest.stations)) {
    snap.stations = snap.stations.map(s => {
      if (!s.error) return s;
      const old = prevLatest.stations.find(o => o.station === s.station && !o.error);
      return old ? { ...old, stale: true, staleError: s.error, staleSince: old.staleSince || prevLatest.ranAt } : s;
    });
  }

  snap.meta = {
    source: "github-actions", modelVersion: HT.MODEL_VERSION, morningRun: morning,
    lastMorningDate: morning ? etDate : (state.lastMorningDate || null),
    missedMorning: (!morning && state.lastMorningDate !== etDate && state.missedMorning === etDate) ? etDate : null,
    climateDay: "midnight to midnight local standard time (NWS CLI convention)",
  };

  // ---- persist, in dependency order: state and stats before the snapshot
  if (morning) { state.lastMorningDate = etDate; if (state.missedMorning === etDate) delete state.missedMorning; }
  const cacheEntries = [...cliCache.entries()].slice(-600);
  state.cliCache = Object.fromEntries(cacheEntries);
  state.updated = new Date().toISOString();
  writeJSON(F.state, state);
  writeJSON(F.stats, out.stats);
  writeJSON(F.latest, snap);

  // ---- settlement ledger: every FINAL CLI max seen
  const ledger = readJSON(F.cli, {});
  for (const s of snap.stations) {
    if (s.error || s.stale || !Array.isArray(s.cli)) continue;
    const L = ledger[s.station] = ledger[s.station] || {};
    for (const c of s.cli) {
      const prev = L[c.d];
      if (!prev) L[c.d] = { max: c.max, at: c.at || null, firstSeen: snap.ranAt };
      else if (prev.max !== c.max) {
        L[c.d] = { ...prev, max: c.max, at: c.at || null, revisedFrom: prev.max, revisedSeen: snap.ranAt };
      }
    }
  }
  writeJSON(F.cli, ledger, true);

  // ---- append-only history of every call
  const month = snap.ranAt.slice(0, 7);
  for (const s of snap.stations) {
    if (s.error || s.stale || !s.today) continue;
    appendLine(path.join(DATA, "history", month + ".jsonl"), {
      at: snap.ranAt, morning, st: s.station, date: s.today.date,
      point: s.today.point, base: s.today.pointBase ?? null, i50: s.today.i50, i80: s.today.i80,
      sd: s.today.sigma, conf: s.today.conf, settled: !!s.today.settled,
      obs: s.today.obsMaxLabel, obsMax: s.today.obsMax, obsPrecise: s.today.obsPrecise,
      now: s.today.current, inferred: !!s.today.currentInferred, peakH: s.today.peakH,
      top: s.today.top, tmr: s.tomorrow ? { date: s.tomorrow.date, point: s.tomorrow.point, i80: s.tomorrow.i80 } : null,
    });
  }

  let archived = null, archiveErr = null;
  try { archived = await archiveMetars(); } catch (e) { archiveErr = String(e.message || e); }

  const gapMin = status.lastRunAt ? Math.round((t0 - new Date(status.lastRunAt)) / 60000) : null;
  const run = {
    at: snap.ranAt, ok: true, morning, durationS: Math.round((Date.now() - t0) / 1000), gapMin,
    scored: out.scoredCount, pending: out.pendingCount, queueWasEmpty: out.queueWasEmpty,
    errors, archived, archiveErr,
  };
  appendLine(F.runs, run);
  writeJSON(F.status, {
    lastRunAt: snap.ranAt, lastOkAt: snap.ranAt, lastOk: true, lastError: null,
    lastMorningDate: state.lastMorningDate || null, missedMorning: snap.meta.missedMorning,
    modelVersion: HT.MODEL_VERSION, stationErrors: errors, gapMin,
    consecutiveFailures: 0,
  }, true);

  console.log(JSON.stringify(run));
  for (const s of snap.stations) {
    if (s.error) { console.log(s.station, "ERROR", s.error); continue; }
    console.log(`${s.station} ${s.stale ? "(STALE) " : ""}${s.today.date} ${s.today.point} [${s.today.i80.join("-")}] ${s.today.conf} | ${s.today.obsMaxLabel || "no obs"}`);
  }
}

main().catch(e => {
  const at = new Date().toISOString();
  const msg = String((e && e.stack) || e);
  console.error(msg);
  const status = readJSON(F.status, {});
  try {
    appendLine(F.runs, { at, ok: false, error: String(e.message || e) });
    writeJSON(F.status, { ...status, lastRunAt: at, lastOk: false, lastError: String(e.message || e),
                          consecutiveFailures: (status.consecutiveFailures || 0) + 1 }, true);
  } catch (e2) { /* nothing more to do */ }
  process.exit(1);                     // fails the workflow -> GitHub emails the owner
});

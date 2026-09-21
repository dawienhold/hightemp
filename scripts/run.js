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

// ------------------------------------------------------------ phone alerts
/* Push notifications through ntfy (https://ntfy.sh): free, no account. The
   channel name lives in the repository secret NTFY_TOPIC so it never appears in
   this public code. With no secret set, alerts are skipped and nothing else
   changes. Every alert is recorded in state.alerts, so a re-run never repeats it. */
const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();
async function push(title, body, { priority = 3, tags = "" } = {}) {
  if (!NTFY_TOPIC) return false;
  const r = await fetch("https://ntfy.sh/" + encodeURIComponent(NTFY_TOPIC), {
    method: "POST", body,
    headers: { Title: title, Priority: String(priority), Tags: tags,
               Click: "https://dawienhold.github.io/hightemp/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("ntfy HTTP " + r.status);
  return true;
}
const ZONE = { KNYC: ["America/New_York", "ET"], KMIA: ["America/New_York", "ET"],
               KMDW: ["America/Chicago", "CT"], KLAX: ["America/Los_Angeles", "PT"],
               KSFO: ["America/Los_Angeles", "PT"] };
const hh = h => { const x = ((Math.round(h) % 24) + 24) % 24; return (x % 12 === 0 ? 12 : x % 12) + (x < 12 ? " AM" : " PM"); };
const flow = c => !c || c.onshore == null ? "" : c.onshore > 0.45 ? "onshore flow" : c.onshore < -0.45 ? "offshore flow" : "cross-shore flow";
const obsShort = t => {
  if (t.obsMax == null) return "no reading yet";
  if (t.obsSettles && t.obsSettles[0] !== t.obsSettles[1]) return `${t.obsSettles[0]}-${t.obsSettles[1]} so far`;
  return `${Math.round(t.obsMax)} so far`;
};

/* Scoring checkpoints. Every pass writes to history/, but only a few calls a
   day per station go into the scorecard: the 7am call, the first call after
   local noon, and the first call inside the 2-hour pre-peak window. Scoring all
   ~70 intraday passes would drown the scorecard in near-certain late calls and
   make it look far better than the calls you would actually trade on. */
function keepCheckpoints(snap, morning, now) {
  state.logged = state.logged || {};
  const fresh = new Set(), keep = new Set();
  for (const s of snap.stations) {
    if (s.error || s.stale || !s.today) continue;
    const t = s.today, [tz] = ZONE[s.station] || ["America/New_York"];
    const localH = HT.localHour(now, tz);
    const peak = t.peakH >= 10 ? t.peakH : 14;
    const slots = [];
    if (morning) slots.push("morning");
    if (localH >= peak - 2) slots.push("prepeak");
    else if (localH >= 12) slots.push("midday");
    for (const slot of slots) {
      const key = `${t.date}|${s.station}|${slot}`;
      if (!state.logged[key]) { state.logged[key] = snap.ranAt; keep.add(s.station); break; }
    }
  }
  const before = state.pending.length;
  state.pending = state.pending.filter(r => r.at !== snap.ranAt || keep.has(r.station));
  const cutoff = new Date(now.getTime() - 4 * 86400e3).toISOString().slice(0, 10);
  for (const k of Object.keys(state.logged)) if (k.slice(0, 10) < cutoff) delete state.logged[k];

  // One-time cleanup of the every-20-minute rows queued before this change:
  // keep the earliest (morning) call per station and date, drop the rest.
  if (!state.checkpointV1) {
    const seen = new Set();
    state.pending = state.pending
      .slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .filter(r => {
        if (r._scored || r.at < "2026-09-21T13:50") return true;   // already scored, or pre-GitHub history
        const k = r.station + "|" + r.date;
        if (seen.has(k)) return r.at === snap.ranAt && keep.has(r.station);
        seen.add(k); return true;
      });
    state.checkpointV1 = new Date().toISOString();
  }
  return { logged: [...keep], dropped: before - state.pending.length };
}

async function sendAlerts(snap, morning, now) {
  const sent = [];
  state.alerts = state.alerts || {};
  const once = async (key, title, body, opt) => {
    if (state.alerts[key]) return;
    if (await push(title, body, opt)) { state.alerts[key] = new Date().toISOString(); sent.push(key); }
  };
  const good = snap.stations.filter(s => !s.error && !s.stale && s.today);

  // Morning call: the five numbers, once per day.
  if (morning && good.length) {
    const line = good.map(s => `${s.station.slice(1)} ${s.today.point} (${s.today.i80[0]}-${s.today.i80[1]})`).join(" · ");
    const p = snap.priorDay;
    const prior = p && p.n ? `\nYesterday: MAE ${p.mae}F, ${Math.round((p.cover80 || 0) * p.n)}/${p.n} in band` : "";
    await once(`${snap.meta.lastMorningDate}|morning`, "7am high-temp calls", line + prior, { tags: "sunrise" });
  }

  for (const s of good) {
    const t = s.today, [tz, abbr] = ZONE[s.station] || ["America/New_York", "ET"];
    const localH = HT.localHour(now, tz);
    // Watch window: 2h before the expected peak. When the models' warmest hour
    // is overnight, the afternoon can still edge above it -- watch from 12.
    const peak = t.peakH >= 10 ? t.peakH : 14;
    const c = t.conditions || {};
    const base = `${t.point} (${t.i80[0]}-${t.i80[1]}), ${obsShort(t)}`;
    if (!t.settled && localH >= peak - 2 && localH < peak + 1) {
      const up = t.upside != null ? `, ${t.upside.toFixed(1)}F upside` : "";
      const note = t.peakH < 10 ? ` · models' warmest hour was overnight` : "";
      await once(`${t.date}|${s.station}|watch`, `${s.station} peak ~${hh(peak)} ${abbr}`,
                 `${base}${up}${flow(c) ? " · " + flow(c) : ""}${note}`, { priority: 4, tags: "thermometer" });
    }
    if (t.settled) {
      await once(`${t.date}|${s.station}|locked`, `${s.station} locked in: ${t.point}`,
                 `${t.obsMaxLabel || base}. Range ${t.i80[0]}-${t.i80[1]}.`, { tags: "lock" });
    }
  }

  // Keep three days of alert history.
  const cutoff = new Date(now.getTime() - 3 * 86400e3).toISOString().slice(0, 10);
  for (const k of Object.keys(state.alerts)) if (k.slice(0, 10) < cutoff) delete state.alerts[k];
  return sent;
}

// ------------------------------------------------------------------- the pass
async function main() {
  const t0 = Date.now();
  const now = new Date();
  if (String(process.env.TEST_PUSH || "").toLowerCase() === "true") {
    const ok = await push("hightemp test", "Alerts are working. You'll get peak-window, lock-in and failure alerts here.", { tags: "white_check_mark" });
    console.log(ok ? "test push sent" : "NTFY_TOPIC secret not set - no push sent");
  }
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

  const checkpoints = keepCheckpoints(snap, morning, now);
  let alertsSent = [], alertErr = null;
  try { alertsSent = await sendAlerts(snap, morning, now); } catch (e) { alertErr = String(e.message || e); }

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
    scored: out.scoredCount, pending: state.pending.length, queueWasEmpty: out.queueWasEmpty,
    errors, archived, archiveErr, alertsSent, alertErr, checkpoints: checkpoints.logged,
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

main().catch(async e => {
  const at = new Date().toISOString();
  const msg = String((e && e.stack) || e);
  console.error(msg);
  const status = readJSON(F.status, {});
  try {
    appendLine(F.runs, { at, ok: false, error: String(e.message || e) });
    const fails = (status.consecutiveFailures || 0) + 1;
    writeJSON(F.status, { ...status, lastRunAt: at, lastOk: false, lastError: String(e.message || e),
                          consecutiveFailures: fails }, true);
    if (fails === 2 || fails % 9 === 0) {
      await push("hightemp run failing", `${fails} runs in a row have failed: ${String(e.message || e).slice(0, 180)}`,
                 { priority: 4, tags: "warning" });
    }
  } catch (e2) { /* nothing more to do */ }
  process.exit(1);                     // fails the workflow -> GitHub emails the owner
});

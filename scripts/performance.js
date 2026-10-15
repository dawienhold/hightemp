"use strict";
const fs=require("node:fs"),path=require("node:path");
// --------------------------------------------------- read-only performance diagnostics
// These diagnostics never feed the forecast. They exist so each engine version can
// be evaluated on its own and so station x local-hour bias can accumulate
// prospectively before anyone considers applying it.
const PERF_TZ = {
  KNYC:"America/New_York", KPHL:"America/New_York", KMIA:"America/New_York", KMDW:"America/Chicago",
  KLAX:"America/Los_Angeles", KSFO:"America/Los_Angeles",
};
function localHourAt(station, iso) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PERF_TZ[station] || "UTC", hour:"2-digit", minute:"2-digit", hourCycle:"h23",
    }).formatToParts(new Date(iso));
    const h = Number(parts.find(x => x.type === "hour")?.value);
    const m = Number(parts.find(x => x.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : null;
  } catch (_) { return null; }
}
function historyRows(DATA) {
  const dir = path.join(DATA, "history");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
    try {
      for (const ln of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch (_) { /* preserve the rest of the audit log */ }
      }
    } catch (_) { /* one unreadable month must not break a forecast pass */ }
  }
  return out;
}
function versionAt(iso, changes, currentVersion) {
  const sorted = (changes || []).slice().sort((a,b) => String(a.at).localeCompare(String(b.at)));
  let v = sorted.length ? sorted[0].from : currentVersion;
  const t = Date.parse(iso || "");
  for (const ch of sorted) {
    const ct = Date.parse(ch.at || "");
    if (Number.isFinite(t) && Number.isFinite(ct) && t >= ct) v = ch.to || v;
  }
  return v || currentVersion;
}
function perfMetric(rows) {
  if (!rows.length) return null;
  const err = rows.map(r => r.point - r.actual);
  const dist = rows.filter(r => Number.isFinite(r.brier));
  return {
    n: rows.length,
    days: new Set(rows.map(r => r.date)).size,
    stationDays: new Set(rows.map(r => r.station + "|" + r.date)).size,
    mae: +(err.reduce((s,e)=>s+Math.abs(e),0)/rows.length).toFixed(2),
    bias: +(err.reduce((s,e)=>s+e,0)/rows.length).toFixed(2),
    within1: +(err.filter(e=>Math.abs(e)<=1).length/rows.length).toFixed(3),
    within2: +(err.filter(e=>Math.abs(e)<=2).length/rows.length).toFixed(3),
    cover80: +(rows.filter(r=>r.inside80).length/rows.length).toFixed(3),
    distN: dist.length,
    brier: dist.length ? +(dist.reduce((s,r)=>s+r.brier,0)/dist.length).toFixed(4) : null,
    pTruth: dist.length ? +(dist.reduce((s,r)=>s+r.pTruth,0)/dist.length).toFixed(3) : null,
  };
}
function buildPerformance(ledger, stats, DATA, currentVersion) {
  const changes = Array.isArray(stats?.versionChanges) ? stats.versionChanges : [];
  const scored = [];
  for (const h of historyRows(DATA)) {
    const actual = ledger?.[h.st]?.[h.date]?.max;
    if (!Number.isFinite(actual) || !Number.isFinite(h.point)) continue;
    const modelVersion = h.modelVersion || versionAt(h.at, changes, currentVersion);
    const full = Array.isArray(h.buckets) && h.buckets.length ? h.buckets : null;
    const truth = full ? full.find(b => b.f === actual) : null;
    let brier = null;
    if (full) {
      brier = truth ? 0 : 1;
      for (const b of full) brier += Math.pow(Number(b.p || 0) - (b.f === actual ? 1 : 0), 2);
      brier = +brier.toFixed(4);
    }
    scored.push({
      station:h.st, date:h.date, at:h.at, point:h.point, actual, modelVersion,
      localH:Number.isFinite(h.localH) ? h.localH : localHourAt(h.st, h.at),
      inside80:Array.isArray(h.i80) && actual >= h.i80[0] && actual <= h.i80[1],
      biasTrack:h.biasTrack === true,
      brier, pTruth:truth ? Number(truth.p || 0) : (full ? 0 : null),
    });
  }

  const versions = [];
  const byVersion = new Map();
  for (const r of scored) {
    if (!byVersion.has(r.modelVersion)) byVersion.set(r.modelVersion, []);
    byVersion.get(r.modelVersion).push(r);
  }
  for (const [version, rows] of byVersion) {
    versions.push({
      version, firstAt:rows.map(r=>r.at).sort()[0], lastAt:rows.map(r=>r.at).sort().slice(-1)[0],
      ...perfMetric(rows),
    });
  }
  versions.sort((a,b) => String(a.firstAt).localeCompare(String(b.firstAt)));

  // Prospective only: these rows begin carrying biasTrack=true with this
  // instrumentation. Keep them separate from inferred historical version stats.
  const tracked = scored.filter(r => r.biasTrack && Number.isFinite(r.localH));
  const cells = new Map();
  for (const r of tracked) {
    const hour = Math.floor(r.localH);
    const key = r.modelVersion + "|" + r.station + "|" + hour;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  const stationHour = [...cells.entries()].map(([key, rows]) => {
    const [version, station, hour] = key.split("|");
    return { version, station, hour:Number(hour), ...perfMetric(rows) };
  }).sort((a,b) => a.station.localeCompare(b.station) || a.hour-b.hour || a.version.localeCompare(b.version));

  // One call per station/date/checkpoint gives each settled date one vote.
  // A late updater is not silently carried into the next checkpoint.
  const first = new Map();
  for (const r of tracked.slice().sort((a,b)=>a.at.localeCompare(b.at))) {
    const hour=Math.floor(r.localH);
    if (![7,10,14,18].includes(hour) || r.modelVersion !== currentVersion) continue;
    const k=[r.station,r.date,hour].join('|');
    if(!first.has(k))first.set(k,{...r,hour});
  }
  const dailyGroups=new Map();
  for(const r of first.values()) {
    const k=r.station+'|'+r.hour;
    if(!dailyGroups.has(k))dailyGroups.set(k,[]);
    dailyGroups.get(k).push(r);
  }
  const checkpoints=[...dailyGroups.values()].map(rows=>({station:rows[0].station,hour:rows[0].hour,...perfMetric(rows)}));

  return {
    schemaVersion:1, generatedAt:new Date().toISOString(), currentVersion:currentVersion,
    versionMethod:"Historical rows are assigned from the recorded version-change timestamps; new rows carry an explicit modelVersion.",
    stationHourStatus:"TRACKING_ONLY",
    stationHourMinSamplesBeforeConsideration:20,
    stationHourNote:"Prospective station x local-hour bias tracker. It is display-only and is not applied to forecasts.",
    versions, stationHour, checkpoints,
    checkpointMethod:"First call within the named local hour, once per station/date; no forward fill. At least 20 distinct settled dates before reviewing a correction.",
    calibrationDecision:"HOLD: limited independent station-hour dates; no fitted high-temperature offsets or probability tightening applied.",
  };
}


module.exports={buildPerformance,localHourAt,perfMetric};

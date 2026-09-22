/* ============================================================================
   HIGH-TEMP ENGINE  v3
   Forecasts the reported daily maximum temperature at KNYC, KMIA, KMDW, KLAX,
   KSFO, and tracks it against what those stations actually report.

   Settlement truth : NWS CLI daily climate report MAXIMUM (whole degF).
   Observations     : two feeds, deliberately. api.weather.gov gives the dense
                      5-minute series, which for KMIA/KMDW/KLAX/KSFO is whole
                      degC and therefore only ever pins the maximum to within
                      ~0.9 degF. aviationweather.gov gives the hourly METARs and
                      SPECIs, whose T-group carries tenths and whose 6-hourly
                      remark group pins the period maximum exactly -- and gives
                      them on time, which the NWS feed does not reliably do.
                      KNYC is hourly only -- its intraday curve is inferred from
                      four 5-minute neighbours and re-anchored to each Central
                      Park reading.
   Guidance         : Open-Meteo multi-model + GEFS/ECMWF ensembles,
                      NWS gridpoint (NBM).

   A whole-degree Celsius reading is a RANGE, not a measurement. Converting it
   to Fahrenheit manufactures a decimal the station never measured -- 32C looks
   like "89.6F" and is really 88.7-90.3F, which straddles two whole degrees and
   so cannot say which degree the day settles on. Every observed maximum is
   therefore carried with its band and the degrees it could settle to, and
   `obsMaxLabel` is the only form that should be quoted.

   Two separate calibrations, which measure different things:
     BIAS  - station minus model ANALYSIS over the trailing month. This is the
             grid-cell-vs-sensor offset, and it is what makes the output track
             THESE stations rather than the air above them.
     SKILL - station minus the model's own DAY-AHEAD FORECAST (previous-runs
             API). This is real forecast error, and it is what sets the width
             of the confidence interval. Using the analysis for this would
             understate the error badly, because the analysis has already seen
             the weather.

   Pure functions plus fetchers; no DOM. Shared by the local engine page and
   the scheduled morning pass.
   ========================================================================= */

const HT = (() => {
"use strict";

/** Bumped whenever the forecast logic changes, so the scorecard can say so. */
const MODEL_VERSION = "4.0.0";

// ---------------------------------------------------------------- stations
const STATIONS = [
  { id:"KNYC", short:"NYC", name:"New York", site:"Central Park", cli:"NYC",
    tz:"America/New_York", lat:40.7833, lon:-73.9667, elev:47, wfo:"OKX", gx:34, gy:45, onshore:160,
    proxies:["KLGA","KEWR","KJRB","KTEB"], hourlyOnly:true,
    caveat:"Central Park transmits hourly only. Between readings the curve is inferred from KLGA, KEWR, KJRB and KTEB (5-minute) and re-anchored to each Central Park observation, so it always passes through the station's own values." },
  { id:"KMIA", short:"MIA", name:"Miami", site:"Miami Intl", cli:"MIA",
    tz:"America/New_York", lat:25.7906, lon:-80.3164, elev:3, wfo:"MFL", gx:105, gy:51, onshore:110, proxies:[] },
  { id:"KMDW", short:"MDW", name:"Chicago", site:"Midway", cli:"MDW",
    tz:"America/Chicago", lat:41.7842, lon:-87.7553, elev:188, wfo:"LOT", gx:72, gy:69, onshore:70, proxies:[] },
  { id:"KLAX", short:"LAX", name:"Los Angeles", site:"LAX", cli:"LAX",
    tz:"America/Los_Angeles", lat:33.9381, lon:-118.3889, elev:38, wfo:"LOX", gx:149, gy:41, onshore:250, proxies:[] },
  { id:"KSFO", short:"SFO", name:"San Francisco", site:"SFO", cli:"SFO",
    tz:"America/Los_Angeles", lat:37.6196, lon:-122.3656, elev:3, wfo:"MTR", gx:85, gy:98, onshore:285, proxies:[] },
];

const MODELS = ["gfs_hrrr","gfs_seamless","ecmwf_ifs025","ecmwf_aifs025_single",
                "icon_seamless","gem_seamless","ukmo_seamless","jma_seamless",
                "meteofrance_seamless","gfs_graphcast025"];

const MODEL_LABEL = {
  gfs_hrrr:"HRRR", gfs_seamless:"GFS", ecmwf_ifs025:"ECMWF", ecmwf_aifs025_single:"ECMWF-AIFS",
  icon_seamless:"ICON", gem_seamless:"GEM", ukmo_seamless:"UKMO", jma_seamless:"JMA",
  meteofrance_seamless:"ARPEGE", gfs_graphcast025:"GraphCast", nbm:"NBM / NWS",
};

const W_D0 = { gfs_hrrr:1.4, nbm:1.5, ecmwf_ifs025:1.2, gfs_seamless:1.1,
               ecmwf_aifs025_single:1.0, icon_seamless:1.0, gem_seamless:0.8,
               ukmo_seamless:0.8, meteofrance_seamless:0.8, gfs_graphcast025:0.8, jma_seamless:0.6 };
const W_D1 = { ecmwf_ifs025:1.4, nbm:1.3, ecmwf_aifs025_single:1.2, gfs_seamless:1.1,
               icon_seamless:1.0, gfs_hrrr:0.8, gem_seamless:0.9, ukmo_seamless:0.9,
               gfs_graphcast025:0.9, meteofrance_seamless:0.8, jma_seamless:0.7 };

// ------------------------------------------------------------------- math
const cToF = c => c * 9 / 5 + 32;
const num  = v => (typeof v === "number" && isFinite(v)) ? v : null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function median(a) {
  const s = a.filter(x => x != null && isFinite(x)).slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(a) {
  const m = median(a);
  if (m == null) return null;
  const d = a.filter(x => x != null && isFinite(x)).map(x => Math.abs(x - m));
  const mm = median(d);
  return mm == null ? null : 1.4826 * mm;
}
function weightedMean(pairs) {
  let sv = 0, sw = 0;
  for (const [v, w] of pairs) if (v != null && isFinite(v) && w > 0) { sv += v * w; sw += w; }
  return sw > 0 ? sv / sw : null;
}
function normCdf(z) {
  const s = z < 0 ? -1 : 1; z = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

// -------------------------------------------------------------- time / tz
function localDate(d, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function localHour(d, tz) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour:"2-digit", minute:"2-digit", hourCycle:"h23" }).formatToParts(d);
  const g = t => +p.find(x => x.type === t).value;
  return g("hour") + g("minute") / 60;
}
function localClock(d, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour:"numeric", minute:"2-digit" }).format(d);
}
/**
 * The NWS climatological day runs midnight to midnight LOCAL STANDARD TIME, all
 * year. While daylight time is in force the CLI for a date therefore covers
 * 1:00 AM to 1:00 AM on the wall clock, and a reading at 12:30 AM CDT belongs to
 * the PREVIOUS date's report. Every "which day does this reading settle" question
 * goes through here; localDate() is for display only.
 */
const STD_OFFSET_H = { "America/New_York": -5, "America/Chicago": -6,
                       "America/Denver": -7, "America/Phoenix": -7, "America/Los_Angeles": -8 };
function climDate(d, tz) {
  const off = STD_OFFSET_H[tz];
  if (off == null) return localDate(d, tz);
  return new Date(d.getTime() + off * 3600e3).toISOString().slice(0, 10);
}

/** 1 while daylight time is in force on `ymd`, else 0: how many wall-clock hours
 *  the climate day is shifted (it then runs 1 AM to 1 AM local). */
function dstShiftH(ymd, tz) {
  const off = STD_OFFSET_H[tz];
  if (off == null) return 0;
  const probe = new Date(ymd + "T17:00:00Z");
  const stdHour = (17 + off + 24) % 24;
  return Math.round(localHour(probe, tz) - stdHour + 24) % 24 === 1 ? 1 : 0;
}

function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------- fetching
const _mem = new Map();
async function getJSON(url, ttlMs = 0) {
  const hit = _mem.get(url);
  if (hit && ttlMs && Date.now() - hit.t < ttlMs) return hit.v;
  const headers = { Accept: "application/geo+json,application/json" };
  if (typeof window === "undefined") headers["User-Agent"] = "hightemp-desk (github.com/dawienhold/hightemp)";
  let v, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const opt = { headers };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opt.signal = AbortSignal.timeout(45000);
      const r = await fetch(url, opt);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url.split("?")[0]);
      v = await r.json(); lastErr = null; break;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  if (lastErr) throw lastErr;
  _mem.set(url, { t: Date.now(), v });
  return v;
}

const OM    = "https://api.open-meteo.com/v1/forecast";
const OMPREV= "https://previous-runs-api.open-meteo.com/v1/forecast";
const OMENS = "https://ensemble-api.open-meteo.com/v1/ensemble";
const NWS   = "https://api.weather.gov";
const AVWX  = "https://aviationweather.gov/api/data/metar";

// Optional NOAA MADIS One-Minute ASOS cache. A free helper script can populate
// docs/data/madis_omo.json before each forecast pass. Keeping the downloader out
// of this shared browser/Node engine avoids exposing credentials and avoids
// shipping a NetCDF parser to the browser.
function loadMadisOMOFile(stationId, sinceISO) {
  if (typeof window !== "undefined" || typeof require === "undefined") return [];
  try {
    const fs = require("fs"), path = require("path");
    const file = process.env.MADIS_OMO_FILE || path.resolve(process.cwd(), "docs/data/madis_omo.json");
    if (!fs.existsSync(file)) return [];
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(doc) ? doc : ((doc && doc.stations && doc.stations[stationId]) || []);
    const lo = sinceISO ? Date.parse(sinceISO) : -Infinity;
    return rows.map(r => ({
      t: new Date(r.t || r.time),
      c: num(r.c),
      f: num(r.f),
      source: "MADIS OMO",
      omo: true,
    })).filter(r => !isNaN(+r.t) && +r.t >= lo && (r.c != null || r.f != null));
  } catch (e) { return []; }
}

// --------------------------------------------------------------- CLI text
const MONTHS = { JANUARY:1, FEBRUARY:2, MARCH:3, APRIL:4, MAY:5, JUNE:6, JULY:7,
                 AUGUST:8, SEPTEMBER:9, OCTOBER:10, NOVEMBER:11, DECEMBER:12 };

function parseCLI(text) {
  const t = text.replace(/\r/g, "");
  const dm = t.match(/CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i);
  if (!dm) return null;
  const mo = MONTHS[dm[1].toUpperCase()];
  if (!mo) return null;
  const date = `${dm[3]}-${String(mo).padStart(2,"0")}-${String(+dm[2]).padStart(2,"0")}`;
  const ti = t.search(/TEMPERATURE\s*\(F\)/i);
  const body = ti >= 0 ? t.slice(ti) : t;
  const mx = body.match(/^\s*MAXIMUM\s+(-?\d+)\s+(\d{1,4}\s*(?:AM|PM))?/mi);
  const mn = body.match(/^\s*MINIMUM\s+(-?\d+)/mi);
  if (!mx) return null;
  const asOf = t.match(/VALID\s+(?:TODAY\s+)?AS\s+OF\s+(\d{3,4})\s*(AM|PM)\s+LOCAL\s+TIME/i);
  return { date, max: +mx[1], min: mn ? +mn[1] : null, maxTime: mx[2] ? mx[2].trim() : null,
           asOf: asOf ? asOf[1].padStart(4, "0") + " " + asOf[2].toUpperCase() : null };
}

/** "0400 PM" (local STANDARD time, as the CLI writes it) on `date` -> UTC ms. */
function cliClockToUTC(date, hhmm, tz) {
  const m = String(hhmm || "").match(/^(\d{1,2})(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = +m[1] % 12; if (/PM/i.test(m[3])) h += 12;
  const off = STD_OFFSET_H[tz] ?? 0;
  return new Date(date + "T00:00:00Z").getTime() + (h - off) * 3600e3 + (+m[2]) * 60e3;
}

async function fetchCLI(st, cache) {
  const list = await getJSON(`${NWS}/products/types/CLI/locations/${st.cli}`, 20 * 60e3);
  const graph = (list && list["@graph"]) || [];
  const out = [], prelim = [];
  for (const p of graph.slice(0, 64)) {
    let rec = cache && cache.get(p.id);
    if (!rec) {
      try {
        const prod = await getJSON(`${NWS}/products/${p.id}`);
        rec = parseCLI(prod.productText || "");
      } catch (e) { rec = null; }
      if (cache) cache.set(p.id, rec || { bad: true });
    }
    if (rec && !rec.bad) {
      // Final once issued after the climate day closed (midnight standard time).
      const off = STD_OFFSET_H[st.tz] ?? 0;
      const closeUTC = new Date(addDays(rec.date, 1) + "T00:00:00Z").getTime() - off * 3600e3;
      const final = !!p.issuanceTime && new Date(p.issuanceTime).getTime() >= closeUTC;
      if (final) out.push({ ...rec, issued: p.issuanceTime, final: true, productId: p.id });
      else prelim.push({ ...rec, issued: p.issuanceTime, final: false, productId: p.id });
    }
  }
  const seen = new Set(), ded = [];
  // newest date first; within a date the latest issuance wins (corrections)
  out.sort((a, b) => b.date.localeCompare(a.date) || String(b.issued).localeCompare(String(a.issued)));
  for (const r of out) if (!seen.has(r.date)) { seen.add(r.date); ded.push(r); }
  // Same-day preliminary reports (e.g. "VALID TODAY AS OF 0400 PM"). Never used
  // for scoring -- only a final CLI settles a call -- but the maximum in one is
  // the station's own ASOS maximum so far, so it is a hard floor for today.
  prelim.sort((a, b) => String(b.issued).localeCompare(String(a.issued)));
  ded.prelim = prelim;
  return ded;
}

// ---------------------------------------------------------- observations
/** 6-hour maximum group from METAR remarks: 1sTTT, tenths of degC. */
function sixHourMaxC(raw) {
  if (!raw) return null;
  const i = raw.indexOf("RMK");
  if (i < 0) return null;
  const m = raw.slice(i).match(/(?:^|\s)1([01])(\d{3})(?:\s|$)/);
  if (!m) return null;
  const v = (+m[2]) / 10;
  return m[1] === "1" ? -v : v;
}

/** Hourly T-group from METAR remarks: TsTTTsDDD, tenths of degC. */
function tGroupC(raw) {
  if (!raw) return null;
  const i = raw.indexOf("RMK");
  if (i < 0) return null;
  const m = raw.slice(i).match(/\sT([01])(\d{3})([01])(\d{3})/);
  if (!m) return null;
  const v = (+m[2]) / 10;
  return m[1] === "1" ? -v : v;
}

/**
 * Hourly METARs and SPECIs: the tenths-of-degC T-group, and the 6-hourly
 * maximum group that actually settles a day.
 *
 * api.weather.gov carries the same text in rawMessage, but it stalls. On
 * 2026-09-18 it kept serving KMIA's 5-minute temperatures for two hours after
 * it stopped serving the hourly METARs, so the 18Z six-hour group -- the group
 * that decided whether the day settled 89 or 90 -- was simply missing, while
 * the dense whole-degree series made the day look unresolved. This feed had it
 * on time. The maximum is read from here; the NWS feed supplies the curve.
 *
 * `obsTime` is the true observation time. `reportTime` is rounded to the hour
 * (17:53Z comes back as 18:00Z), which would file the six-hour group under the
 * wrong synoptic window.
 */
async function fetchMetars(stationId, hours = 30) {
  const d = await getJSON(`${AVWX}?ids=${encodeURIComponent(stationId)}&format=json&hours=${hours}`, 3 * 60e3);
  const rows = [];
  for (const o of (Array.isArray(d) ? d : [])) {
    const t = o.obsTime ? new Date(o.obsTime * 1000) : (o.reportTime ? new Date(o.reportTime) : null);
    if (!t || isNaN(+t)) continue;
    rows.push({ t, c: num(o.temp), raw: o.rawOb || "" });
  }
  return rows;
}

/**
 * The day's readings, from both feeds, one row per minute. A tenths-resolution
 * row always displaces a whole-degree one at the same minute, and a six-hour
 * group is never dropped in the merge. Either feed failing leaves the other
 * carrying the day.
 */
async function fetchObs(stationId, sinceISO, hours) {
  const byMin = new Map();
  const put = row => {
    const k = Math.round(row.t.getTime() / 60e3);
    const prev = byMin.get(k);
    if (!prev) { byMin.set(k, row); return; }
    const win = (row.precise && !prev.precise) ? row : prev;
    byMin.set(k, { ...win, sixMaxC: prev.sixMaxC != null ? prev.sixMaxC : row.sixMaxC });
  };
  const add = (t, c, raw, source = null, omo = false) => {
    const tg = tGroupC(raw);
    const cc = tg != null ? tg : c;
    if (cc == null || !isFinite(cc)) return;
    put({ t, f: cToF(cc), c: cc,
          precise: tg != null || Math.abs(cc * 10 % 10) > 0.01,
          sixMaxC: sixHourMaxC(raw), source, omo });
  };

  try {
    const d = await getJSON(`${NWS}/stations/${stationId}/observations?start=${encodeURIComponent(sinceISO)}`);
    for (const f of ((d && d.features) || [])) {
      const p = f.properties;
      add(new Date(p.timestamp), num(p.temperature && p.temperature.value), p.rawMessage || "", "NWS observations", false);
    }
  } catch (e) { /* the METAR feed below can still carry the day */ }

  try {
    for (const m of await fetchMetars(stationId, hours)) add(m.t, m.c, m.raw, "AviationWeather METAR", false);
  } catch (e) { /* fall back to whatever the NWS feed gave */ }

  // Free NOAA MADIS One-Minute ASOS cache, if the pre-pass helper populated it.
  // OMO temperature is useful cadence evidence but is still coarse whole-degree C
  // at many ASOS sites, so it must never be treated as tenths-resolution truth.
  for (const m of loadMadisOMOFile(stationId, sinceISO)) {
    const cc = m.c != null ? m.c : (m.f - 32) * 5 / 9;
    add(m.t, cc, "", m.source, true);
  }

  return [...byMin.values()].sort((a, b) => a.t - b.t);
}

async function fetchDayObs(st, nowD) {
  const today = climDate(nowD, st.tz);
  const startUTC = new Date(new Date(today + "T00:00:00Z").getTime() - 30 * 3600e3).toISOString();
  const hours = clamp(Math.ceil((nowD - new Date(startUTC)) / 3600e3) + 1, 2, 48);
  const prim = await fetchObs(st.id, startUTC, hours);
  const keep = prim.filter(r => climDate(r.t, st.tz) === today);

  let proxy = [];
  if (st.proxies && st.proxies.length) {
    const sets = await Promise.all(st.proxies.map(p => fetchObs(p, startUTC, hours).catch(() => [])));
    const byBucket = new Map();
    sets.forEach(rows => {
      for (const r of rows) {
        if (climDate(r.t, st.tz) !== today) continue;
        const k = Math.round(r.t.getTime() / 300e3) * 300e3;
        if (!byBucket.has(k)) byBucket.set(k, []);
        byBucket.get(k).push(r.f);
      }
    });
    proxy = [...byBucket.entries()].sort((a, b) => a[0] - b[0])
      .map(([k, v]) => ({ t: new Date(k), f: v.reduce((s, x) => s + x, 0) / v.length, n: v.length }));
  }
  return { today, obs: keep, proxy };
}

function inferSubHourly(obs, proxy) {
  if (!proxy.length || !obs.length) return [];
  const out = [];
  for (const p of proxy) {
    let anchor = null;
    for (const o of obs) { if (o.t <= p.t) anchor = o; else break; }
    if (!anchor) continue;
    let pa = null, best = Infinity;
    for (const q of proxy) { const d = Math.abs(q.t - anchor.t); if (d < best) { best = d; pa = q; } }
    if (!pa || best > 20 * 60e3) continue;
    const ageH = (p.t - anchor.t) / 3600e3;
    if (ageH <= 0 || ageH > 1.6) continue;
    out.push({ t: p.t, f: p.f + (anchor.f - pa.f), inferred: true });
  }
  return out;
}

// ------------------------------------------------------------- guidance
async function fetchDaily(st, pastDays = 31) {
  const d = await getJSON(`${OM}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=${encodeURIComponent(st.tz)}`
    + `&past_days=${pastDays}&forecast_days=3&models=${MODELS.join(",")}`, 10 * 60e3);
  const byModel = {};
  for (const m of MODELS) byModel[m] = d.daily["temperature_2m_max_" + m] || [];
  return { time: d.daily.time, byModel };
}

async function fetchHourly(st) {
  const d = await getJSON(`${OM}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=${encodeURIComponent(st.tz)}`
    + `&past_days=1&forecast_days=3&models=${MODELS.join(",")}`, 10 * 60e3);
  const byModel = {};
  for (const m of MODELS) byModel[m] = d.hourly["temperature_2m_" + m] || [];
  return { time: d.hourly.time, byModel };
}

/** What each model forecast a day ahead, for the trailing weeks. Real forecast error. */
async function fetchPrevRuns(st, pastDays = 28) {
  const d = await getJSON(`${OMPREV}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&hourly=temperature_2m_previous_day1&temperature_unit=fahrenheit`
    + `&timezone=${encodeURIComponent(st.tz)}&past_days=${pastDays}&forecast_days=1`
    + `&models=${MODELS.join(",")}`, 60 * 60e3);
  const byModel = {};
  for (const m of MODELS) {
    const arr = d.hourly["temperature_2m_previous_day1_" + m];
    if (!arr) continue;
    const byDay = {};
    d.hourly.time.forEach((t, i) => {
      const v = num(arr[i]); if (v == null) return;
      const day = t.slice(0, 10);
      if (byDay[day] == null || v > byDay[day]) byDay[day] = v;
    });
    byModel[m] = byDay;
  }
  return byModel;
}

async function fetchSun(st) {
  return getJSON(`${OM}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&daily=sunrise,sunset&timezone=${encodeURIComponent(st.tz)}&forecast_days=3`, 30 * 60e3);
}

async function fetchEnsemble(st) {
  const d = await getJSON(`${OMENS}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=${encodeURIComponent(st.tz)}`
    + `&forecast_days=3&models=gfs025,ecmwf_ifs025`, 25 * 60e3);
  return { time: d.hourly.time, members: Object.keys(d.hourly).filter(k => /member\d+/.test(k)), data: d.hourly };
}

async function fetchNBM(st) {
  const d = await getJSON(`${NWS}/gridpoints/${st.wfo}/${st.gx},${st.gy}`, 15 * 60e3);
  const mt = (d.properties || {}).maxTemperature || {};
  const uom = mt.uom || "wmoUnit:degC";
  const out = {};
  for (const v of (mt.values || [])) {
    const date = localDate(new Date(v.validTime.split("/")[0]), st.tz);
    const f = /degF/.test(uom) ? v.value : cToF(v.value);
    if (out[date] == null || f > out[date]) out[date] = f;
  }
  return out;
}

// -------------------------------------------------- duplicate model series
/**
 * Open-Meteo serves some model aliases from the same underlying blend
 * (gfs_hrrr and gfs_seamless coincide outside HRRR's range). Left alone they
 * double-count in the consensus, so identical series collapse to one entry.
 */
/* ------------------------------------------------------- conditions ---- */
const COND_VARS = "cloud_cover,shortwave_radiation,wind_speed_10m,wind_direction_10m," +
                  "dew_point_2m,precipitation,relative_humidity_2m,boundary_layer_height";

/** Hourly sky, sun, wind and moisture for the trailing month and the days ahead. */
async function fetchConditions(st, pastDays = 31) {
  return getJSON(`${OM}?latitude=${st.lat}&longitude=${st.lon}&elevation=${st.elev}`
    + `&hourly=${COND_VARS}&temperature_unit=fahrenheit&wind_speed_unit=mph`
    + `&timezone=${encodeURIComponent(st.tz)}&past_days=${pastDays}&forecast_days=3`, 20 * 60e3);
}

/**
 * Collapse the hourly conditions into one row per local day, over the hours
 * that actually decide a maximum (9am to 5pm local).
 *
 * `onshore` is the cosine of the wind direction against the station's own
 * onshore bearing: +1 is flow straight off the water, -1 straight off the land.
 * For KSFO, KLAX, KMIA and KMDW that single number separates a capped day from
 * a blowtorch day better than anything else free.
 */
function dailyDiagnostics(cond, st) {
  if (!cond || !cond.hourly) return {};
  const H = cond.hourly, out = {};
  const bucket = {};
  H.time.forEach((t, i) => {
    const h = +t.slice(11, 13);
    if (h < 9 || h > 17) return;
    const d = t.slice(0, 10);
    (bucket[d] = bucket[d] || []).push(i);
  });
  for (const [d, idx] of Object.entries(bucket)) {
    const avg = k => { const v = idx.map(i => num(H[k][i])).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const mx  = k => { const v = idx.map(i => num(H[k][i])).filter(x => x != null); return v.length ? Math.max(...v) : null; };
    const sum = k => { const v = idx.map(i => num(H[k][i])).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) : null; };
    // wind at the hottest part of the afternoon carries the sea-breeze signal
    const peakIdx = idx.filter(i => { const h = +H.time[i].slice(11, 13); return h >= 13 && h <= 16; });
    let u = 0, v = 0, n = 0;
    for (const i of peakIdx) {
      const dir = num(H.wind_direction_10m[i]), sp = num(H.wind_speed_10m[i]);
      if (dir == null || sp == null) continue;
      const r = dir * Math.PI / 180; u += sp * Math.sin(r); v += sp * Math.cos(r); n++;
    }
    let windDir = null, windSpd = null, onshore = null;
    if (n) {
      windSpd = Math.sqrt(u * u + v * v) / n;
      windDir = (Math.atan2(u / n, v / n) * 180 / Math.PI + 360) % 360;
      if (st.onshore != null) onshore = Math.cos((windDir - st.onshore) * Math.PI / 180);
    }
    out[d] = {
      cloud: avg("cloud_cover"), rad: avg("shortwave_radiation"), rh: avg("relative_humidity_2m"),
      dew: avg("dew_point_2m"), precip: sum("precipitation"), blh: mx("boundary_layer_height"),
      windDir, windSpd, onshore,
    };
  }
  return out;
}

/**
 * How wet the daytime window was, as a class rather than a number.
 *
 * Precipitation does not belong on a smooth axis next to cloud cover. A soaked
 * day and a dry overcast day can both read 95% cloud, but the error the blend
 * makes on them differs in sign as well as size: the dry day is a radiation
 * problem, the wet one adds evaporative cooling, downdrafts and a max that
 * often lands whenever the rain happens to break. Treating the two as
 * neighbours is what would let a dry-day bias be carried onto a rainy one.
 *
 * Millimetres accumulated over the 09-17 local window, matching dailyDiagnostics.
 */
function wetClass(precip) {
  if (precip == null) return null;
  return precip < 0.4 ? 0 : precip < 4 ? 1 : 2;      // dry / damp / wet
}
const WET_LABEL = ["dry", "damp", "wet"];

/**
 * The dimensions a day is matched on, and how much each is trusted to separate
 * one regime from another. cloud and onshore flow carried v3.3 alone; radiation
 * adds cloud THICKNESS where cover alone is blind to it, dew point carries the
 * moisture the mixing has to work against, and boundary layer height is the
 * mixing depth itself.
 */
/**
 * `floor` is the smallest spread, in that dimension's own units, worth treating
 * as a real difference: cloud in %, onshore as a cosine, radiation in W/m2, dew
 * point in F, mixing depth in metres.
 *
 * It matters more than it looks. Distances are normalised by how much the
 * dimension varies across the pool, which adapts the bandwidth to the station
 * -- but a pool with almost no spread in one dimension would otherwise divide
 * by almost nothing and turn a rounding difference into a three-sigma gap. A
 * fortnight of identical marine-layer days is not exotic, and without the floor
 * the analog term would quietly go dark exactly then.
 */
const ANALOG_DIMS = [
  { k: "cloud",   w: 1.00, floor: 8    },
  { k: "onshore", w: 1.00, floor: 0.20 },
  { k: "rad",     w: 0.80, floor: 60   },
  { k: "dew",     w: 0.60, floor: 2.0  },
  { k: "blh",     w: 0.50, floor: 150  },
];
/* No single dimension may contribute more than this to the mean squared z, so
   one wild reading cannot by itself decide that nothing matches. */
const ANALOG_Z2_CAP = 9;

/**
 * Analog correction. Find the past days whose regime most resembles the day
 * being forecast, and carry across the median error the day-ahead blend made
 * on those days.
 *
 * Deliberately timid, and in three separate ways, because a bias applied to a
 * day that never earned it is worse than no bias at all:
 *
 *   - it needs a handful of genuine matches, and is shrunk toward zero by how
 *     few of them there are;
 *   - a day in a different precipitation class is pushed far away, so a dry
 *     pool cannot lend its bias to a rainy day;
 *   - if the target day resembles nothing in the pool, the whole term is
 *     dampened by how poor the best matches actually are, rather than taking
 *     the nearest handful and trusting them because they were nearest.
 *
 * The unadjusted forecast is kept alongside so the scorecard settles whether
 * this term earns its place rather than anyone assuming it does.
 */
function analogAdjust(targetDate, diag, dayAheadErr, opts = {}) {
  const cap = opts.cap ?? 2.5, shrinkN = opts.shrinkN ?? 6, kMax = opts.k ?? 8;
  // added to the mean squared z per step of precipitation class mismatch
  const wetStep = opts.wetStep ?? 2.0;
  // mean kernel weight that counts as a fully trustworthy set of matches
  const trustFull = opts.trustFull ?? 0.55;
  const tgt = diag[targetDate];
  const blank = { adj: 0, n: 0, effN: 0, raw: 0, shrunk: 0, pool: 0, fromMemory: 0, days: [],
                  sim: null, trust: null, dims: [], wet: null, wetPool: null, reason: "no analog data" };
  if (!tgt || tgt.cloud == null) return blank;

  const tgtWet = wetClass(tgt.precip);

  // Two sources of past days: what the APIs still retain, and the system's own
  // accumulated record. The API rows win a tie, being the same computation.
  // Rows written before v3.4 carry no precip or dew; those dimensions are
  // simply skipped for them rather than defaulted, since a missing
  // precipitation figure is not the same claim as a dry day.
  const pool = [];
  const seen = new Set();
  const take = (d, err, c, src) => {
    pool.push({ d, err, src, cloud: c.cloud, onshore: c.onshore ?? null, rad: c.rad ?? null,
                dew: c.dew ?? null, blh: c.blh ?? null,
                precip: c.precip ?? null, wet: wetClass(c.precip ?? null) });
    seen.add(d);
  };
  for (const [d, e] of Object.entries(dayAheadErr)) {
    if (e == null || !diag[d] || diag[d].cloud == null || d === targetDate) continue;
    take(d, e, diag[d], "api");
  }
  for (const m of (opts.memory || [])) {
    if (!m || m.err == null || m.cloud == null || m.d === targetDate || seen.has(m.d)) continue;
    take(m.d, m.err, m, "memory");
  }
  if (pool.length < 5) return { ...blank, wet: tgtWet, reason: `only ${pool.length} scored days` };

  // Spread of each dimension across the pool, so the distance is in units of
  // how much that dimension actually varies at this station.
  const sdOf = a => { const m = a.reduce((s, x) => s + x, 0) / a.length;
                      return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length - 1)) || 1; };
  const sd = {}, used = [];
  for (const { k, floor } of ANALOG_DIMS) {
    if (tgt[k] == null) continue;
    const v = pool.map(x => x[k]).filter(x => x != null);
    if (v.length < 4) continue;                       // too thin to normalise honestly
    sd[k] = Math.max(sdOf(v), floor);
    used.push(k);
  }
  if (!used.length) return { ...blank, wet: tgtWet, reason: "no comparable dimensions" };

  const scored = pool.map(x => {
    // Weighted MEAN of squared z-scores, not the sum: a day compared on four
    // dimensions stays on the same scale as one compared on two, so adding
    // dimensions sharpens the ranking without quietly collapsing every weight.
    let num = 0, den = 0;
    for (const { k, w } of ANALOG_DIMS) {
      if (!sd[k] || x[k] == null) continue;
      num += w * Math.min(ANALOG_Z2_CAP, Math.pow((x[k] - tgt[k]) / sd[k], 2));
      den += w;
    }
    let d2 = den ? num / den : 4;                     // nothing in common: treat as far
    // The precipitation gate. Not absolute -- a mismatched day still counts,
    // weakly -- so that a station with no wet precedent abstains through a
    // collapsed effN rather than through a hard exclusion that hides why.
    const wetGap = (tgtWet != null && x.wet != null) ? Math.abs(tgtWet - x.wet) : 0;
    d2 += wetStep * wetGap;
    return { date: x.d, err: x.err, src: x.src, wet: x.wet, wetGap,
             dist: Math.sqrt(d2), w: Math.exp(-d2 / 2) };
  }).sort((a, b) => a.dist - b.dist).slice(0, kMax);

  const effN = scored.reduce((s, x) => s + x.w, 0);
  const sim = +(effN / scored.length).toFixed(3);     // mean kernel weight of the retained set
  const wetPool = tgtWet == null ? null : scored.filter(x => x.wet === tgtWet).length;
  if (effN < 2) {
    const why = (tgtWet != null && wetPool === 0)
      ? `no ${WET_LABEL[tgtWet]}-regime precedent`
      : "no close analogs";
    return { ...blank, n: scored.length, pool: pool.length, sim, trust: 0,
             dims: used, wet: tgtWet, wetPool, reason: why };
  }

  // weighted median of the analog errors
  const srt = scored.slice().sort((a, b) => a.err - b.err);
  const half = effN / 2;
  let acc = 0, raw = srt[srt.length - 1].err;
  for (const x of srt) { acc += x.w; if (acc >= half) { raw = x.err; break; } }

  // Two independent brakes. The first asks how MANY comparable days there are,
  // the second how CLOSE the best of them actually got. A day unlike anything
  // on record clears the first and fails the second, which is the case this
  // exists for.
  const shrunk = raw * (effN / (effN + shrinkN));
  const trust = Math.max(0, Math.min(1, sim / trustFull));
  const adj = Math.max(-cap, Math.min(cap, shrunk * trust));
  const note = trust < 0.999
    ? (tgtWet != null && wetPool === 0
        ? `dampened ${Math.round((1 - trust) * 100)}%: no ${WET_LABEL[tgtWet]}-regime precedent`
        : `dampened ${Math.round((1 - trust) * 100)}%: weak regime match`)
    : null;
  return { adj, raw, shrunk: +shrunk.toFixed(2), n: scored.length, effN: +effN.toFixed(2),
           pool: pool.length, sim, trust: +trust.toFixed(3), dims: used,
           wet: tgtWet, wetPool,
           fromMemory: pool.filter(x => x.src === "memory").length,
           days: scored.slice(0, 4).map(x => ({ d: x.date, err: +x.err.toFixed(1), dist: +x.dist.toFixed(2),
                                                src: x.src, wet: x.wet == null ? null : WET_LABEL[x.wet] })),
           reason: note };
}

/* ----------------------------------------------------------- scoring ---- */
/**
 * Score a day's logged calls against what the station actually reported.
 * Records absolute error, whether the 80% band held, and the probability the
 * call had assigned to the degree that settled -- the three things that decide
 * whether the stated confidence is honest.
 */
function scoreCalls(calls, settledMax) {
  return calls.map(c => {
    const err = c.point - settledMax;
    const inside80 = settledMax >= c.i80[0] && settledMax <= c.i80[1];
    const inside50 = c.i50 ? (settledMax >= c.i50[0] && settledMax <= c.i50[1]) : null;
    const hit = (c.top || []).find(b => b.f === settledMax);
    const pTruth = hit ? hit.p : 0;
    // Brier over the whole integer distribution
    let brier = 0;
    for (const b of (c.top || [])) brier += Math.pow(b.p - (b.f === settledMax ? 1 : 0), 2);
    const errBase = c.pointBase == null ? null : c.pointBase - settledMax;
    return { station: c.station, at: c.at, leadH: c.leadH, localH: c.localH ?? null,
             band: (c.i80 && c.i80.length === 2) ? c.i80[1] - c.i80[0] : null,
             point: c.point, pointBase: c.pointBase,
             settled: settledMax, err, errBase, absErr: Math.abs(err),
             absErrBase: errBase == null ? null : Math.abs(errBase),
             inside80, inside50, pTruth: +pTruth.toFixed(3), brier: +brier.toFixed(4),
             sigma: c.sigma, regimeAdj: c.regimeAdj ?? null, top: c.top || [] };
  });
}

/**
 * Hours remaining until 23:59 on the forecast date, banded.
 *
 * The v3.4 bands put every intraday pass in one cell: a 7am call has ~17h left
 * and a 4pm call ~8h, and the old "morning" band spanned 6-18h. These are cut
 * finely enough that the five scheduled passes separate, while staying wide
 * enough to absorb the 3h spread between the eastern and western stations
 * reaching the same wall-clock pass at different local times.
 */
const LEAD_BUCKETS = [
  { key: "day-ahead", lo: 24, hi: 48 },
  { key: "overnight", lo: 18, hi: 24 },
  { key: "early-am",  lo: 15, hi: 18 },
  { key: "late-am",   lo: 12, hi: 15 },
  { key: "midday",    lo: 9,  hi: 12 },
  { key: "afternoon", lo: 6,  hi: 9  },
  { key: "peak",      lo: 3,  hi: 6  },
  { key: "late",      lo: -6, hi: 3  },
];
function leadBucket(h) {
  for (const b of LEAD_BUCKETS) if (h >= b.lo && h < b.hi) return b.key;
  return h >= 48 ? "long" : "late";
}

/** Roll scored calls up into the numbers that say whether the model is honest. */
function aggregateScores(rows) {
  const by = (keyFn) => {
    const g = {};
    for (const r of rows) { const k = keyFn(r); (g[k] = g[k] || []).push(r); }
    const out = {};
    for (const [k, v] of Object.entries(g)) {
      const n = v.length;
      const mae = v.reduce((s, r) => s + r.absErr, 0) / n;
      const withBase = v.filter(r => r.absErrBase != null);
      out[k] = {
        n,
        mae: +mae.toFixed(2),
        bias: +(v.reduce((s, r) => s + r.err, 0) / n).toFixed(2),
        within1: +(v.filter(r => r.absErr <= 1).length / n).toFixed(3),
        within2: +(v.filter(r => r.absErr <= 2).length / n).toFixed(3),
        cover80: +(v.filter(r => r.inside80).length / n).toFixed(3),
        cover50: +(v.filter(r => r.inside50 != null).length
          ? v.filter(r => r.inside50).length / v.filter(r => r.inside50 != null).length : 0).toFixed(3),
        brier: +(v.reduce((s, r) => s + r.brier, 0) / n).toFixed(4),
        pTruth: +(v.reduce((s, r) => s + r.pTruth, 0) / n).toFixed(3),
        maeBase: withBase.length ? +(withBase.reduce((s, r) => s + r.absErrBase, 0) / withBase.length).toFixed(2) : null,
        regimeHelped: withBase.length ? +(withBase.filter(r => r.absErr < r.absErrBase).length / withBase.length).toFixed(3) : null,
      };
    }
    return out;
  };
  // reliability: does a stated probability come true that often?
  const bins = [[0, .1], [.1, .2], [.2, .3], [.3, .5], [.5, .75], [.75, 1.01]];
  const reliability = bins.map(([lo, hi]) => {
    const pts = [];
    for (const r of rows) for (const b of (r.top || [])) {
      if (b.p >= lo && b.p < hi) pts.push({ p: b.p, hit: b.f === r.settled ? 1 : 0 });
    }
    if (!pts.length) return { lo, hi, n: 0, stated: null, actual: null };
    return { lo, hi, n: pts.length,
             stated: +(pts.reduce((s, x) => s + x.p, 0) / pts.length).toFixed(3),
             actual: +(pts.reduce((s, x) => s + x.hit, 0) / pts.length).toFixed(3) };
  });
  return {
    overall: by(() => "all").all,
    byStation: by(r => r.station),
    byLead: by(r => leadBucket(r.leadH)),
    reliability,
    days: [...new Set(rows.map(r => (r.at || "").slice(0, 10)))].length,
    updated: new Date().toISOString(),
  };
}

/* --------------------------------------------------- regime memory ------ */
/**
 * The analog term needs (what the day looked like, how wrong we were) pairs.
 * The APIs only retain about a week of the overlap between CLI reports and
 * archived day-ahead runs, so left alone the analog would stay near-dormant
 * forever. This is the system's own accumulating record of that same pairing,
 * built from its OWN day-ahead calls -- the `tomorrow` forecast made yesterday,
 * scored when that day settles.
 *
 * Only genuine day-ahead calls go in, so the errors stay comparable with the
 * API-derived ones rather than mixing lead times.
 *
 * It lives in the browser's storage because that is where the analog runs and
 * where it is free to keep. Clearing site data costs the memory, not the
 * system: the analog simply abstains again and rebuilds.
 */
/* Prior-day reports, newest last. Small: one object per day. */
const REPORT_KEY = "ht.priorday.v1";
const REPORT_CAP = 45;

function loadReports() {
  try {
    const v = JSON.parse(localStorage.getItem(REPORT_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function saveReports(list) {
  try { localStorage.setItem(REPORT_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}
/** One report per date, newest last, capped. A re-run of the same morning replaces it. */
function mergeReports(list, rep) {
  if (!rep || !rep.forDate) return list || [];
  const out = (list || []).filter(r => r.forDate !== rep.forDate);
  out.push(rep);
  out.sort((a, b) => String(a.forDate).localeCompare(String(b.forDate)));
  return out.slice(-REPORT_CAP);
}
/** The compact per-day trail the dashboard plots. */
function reportHistory(list) {
  return (list || []).map(r => ({ d: r.forDate, n: r.n, mae: r.mae, bias: r.bias,
                                  cover80: r.cover80, exact: r.exact,
                                  helped: r.analogHelped, moved: r.analogMoved }));
}

const REGIME_KEY = "ht.regime.v1";
const REGIME_CAP = 200;

function loadRegime() {
  try {
    const v = JSON.parse(localStorage.getItem(REGIME_KEY) || "{}");
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}
function saveRegime(map) {
  try { localStorage.setItem(REGIME_KEY, JSON.stringify(map)); return true; } catch (e) { return false; }
}
/** Add rows, keep one per station-date, newest `REGIME_CAP` per station. */
function mergeRegime(map, rows) {
  const out = { ...(map || {}) };
  for (const r of (rows || [])) {
    if (!r || !r.station || !r.d || r.err == null || r.cloud == null) continue;
    const list = (out[r.station] || []).filter(x => x.d !== r.d);
    list.push({ d: r.d, cloud: r.cloud, onshore: r.onshore ?? null,
                rad: r.rad ?? null, blh: r.blh ?? null,
                // v3.4: the precipitation gate and the moisture dimension need these.
                // Rows written by v3.2 have them absent, which analogAdjust reads as
                // "unknown" rather than "dry".
                precip: r.precip ?? null, dew: r.dew ?? null, rh: r.rh ?? null,
                err: +(+r.err).toFixed(1) });
    list.sort((a, b) => a.d.localeCompare(b.d));
    out[r.station] = list.slice(-REGIME_CAP);
  }
  return out;
}
function regimeCount(map) {
  return Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [k, v.length]));
}

/* ---------------------------------------------------- running statistics */
/**
 * The scorecard is kept as sufficient statistics rather than a growing log, so
 * it stays a few kilobytes however many months it covers. Everything the
 * reliability curve needs is accumulated at scoring time.
 */
const REL_BINS = [[0, .1], [.1, .2], [.2, .3], [.3, .5], [.5, .75], [.75, 1.01]];

function emptyCell() {
  return { n:0, sumAbs:0, sumErr:0, w1:0, w2:0, c80:0, c50:0, c50n:0,
           sumBrier:0, sumP:0, nBase:0, sumAbsBase:0, helped:0,
           // v3.5: the STATED confidence, kept so it can be plotted against
           // when the call was made. nConf is its own counter because cells
           // written before v3.5 have none of this and must report null rather
           // than a zero that would read as perfect certainty.
           nConf:0, sumSigma:0, sumBand:0 };
}
function emptyStats() {
  return { version:2, byStation:{}, byLead:{}, byHour:{}, byStationHour:{}, overall:emptyCell(),
           reliability:REL_BINS.map(([lo,hi]) => ({ lo, hi, n:0, sumStated:0, hits:0 })),
           dates:[], updated:null };
}
function addTo(cell, r) {
  cell.n++;
  cell.sumAbs += r.absErr;
  cell.sumErr += r.err;
  if (r.absErr <= 1) cell.w1++;
  if (r.absErr <= 2) cell.w2++;
  if (r.inside80) cell.c80++;
  if (r.inside50 != null) { cell.c50n++; if (r.inside50) cell.c50++; }
  cell.sumBrier += r.brier;
  cell.sumP += r.pTruth;
  if (r.sigma != null) {
    cell.nConf = (cell.nConf || 0) + 1;
    cell.sumSigma = (cell.sumSigma || 0) + r.sigma;
    cell.sumBand = (cell.sumBand || 0) + (r.band != null ? r.band : 0);
  }
  if (r.absErrBase != null) { cell.nBase++; cell.sumAbsBase += r.absErrBase; if (r.absErr < r.absErrBase) cell.helped++; }
}
/** Fold a day's scored calls into the running statistics. Idempotent per date. */
function accumulate(stats, rows, date) {
  const st = stats && stats.byStation ? stats : emptyStats();
  // The v3.5 lead bands are cut at different boundaries from v3.4's, so cells
  // carried over describe different spans of time under the same names. They are
  // set aside rather than added to or thrown away: mixing them would quietly
  // corrupt the comparison, and deleting them would lose real scored calls.
  if ((st.version || 1) < 2) {
    if (st.byLead && Object.keys(st.byLead).length) st.byLeadLegacy = st.byLead;
    st.byLead = {};
    st.byHour = st.byHour || {};
    st.byStationHour = st.byStationHour || {};
    st.version = 2;
  }
  if (date && st.dates.includes(date)) return st;      // already counted
  for (const r of rows) {
    addTo(st.overall, r);
    st.byStation[r.station] = st.byStation[r.station] || emptyCell();
    addTo(st.byStation[r.station], r);
    const lb = leadBucket(r.leadH);
    st.byLead[lb] = st.byLead[lb] || emptyCell();
    addTo(st.byLead[lb], r);
    // The station's own clock when the call was made. This is the axis the
    // "when should this go in" question is actually about: lead time in hours
    // maps the five daily passes onto a scale that hides them, and it differs
    // by three hours between the eastern and western stations for the same run.
    if (r.localH != null) {
      const hk = String(Math.floor(r.localH)).padStart(2, "0");
      st.byHour = st.byHour || {};
      st.byHour[hk] = st.byHour[hk] || emptyCell();
      addTo(st.byHour[hk], r);
      // Per station as well: SFO's best hour is not NYC's, and pooling the two
      // would average a marine-layer station against a continental one.
      const sk = `${r.station}|${hk}`;
      st.byStationHour = st.byStationHour || {};
      st.byStationHour[sk] = st.byStationHour[sk] || emptyCell();
      addTo(st.byStationHour[sk], r);
    }
    for (const b of (r.top || [])) {
      const bin = st.reliability.find(x => b.p >= x.lo && b.p < x.hi);
      if (!bin) continue;
      bin.n++; bin.sumStated += b.p; if (b.f === r.settled) bin.hits++;
    }
  }
  if (date) { st.dates.push(date); st.dates = [...new Set(st.dates)].sort().slice(-400); }
  st.updated = new Date().toISOString();
  return st;
}
function finishCell(c) {
  if (!c || !c.n) return null;
  return { n:c.n, mae:+(c.sumAbs/c.n).toFixed(2), bias:+(c.sumErr/c.n).toFixed(2),
           within1:+(c.w1/c.n).toFixed(3), within2:+(c.w2/c.n).toFixed(3),
           cover80:+(c.c80/c.n).toFixed(3), cover50:c.c50n?+(c.c50/c.c50n).toFixed(3):null,
           brier:+(c.sumBrier/c.n).toFixed(4), pTruth:+(c.sumP/c.n).toFixed(3),
           maeBase:c.nBase?+(c.sumAbsBase/c.nBase).toFixed(2):null,
           regimeHelped:c.nBase?+(c.helped/c.nBase).toFixed(3):null,
           // Stated confidence: sigma as the model declared it, band as the
           // width of the 80% interval in whole degrees. null on cells carried
           // over from before v3.5 -- absent, not zero.
           sigma:c.nConf?+(c.sumSigma/c.nConf).toFixed(2):null,
           band:c.nConf?+(c.sumBand/c.nConf).toFixed(2):null,
           nConf:c.nConf||0 };
}
/** Turn the running statistics into the shape the scorecard panel reads. */
function finalizeStats(stats) {
  if (!stats || !stats.overall) return null;
  const map = o => Object.fromEntries(Object.entries(o || {}).map(([k,v]) => [k, finishCell(v)]).filter(([,v]) => v));
  return {
    overall: finishCell(stats.overall) || { n:0 },
    byStation: map(stats.byStation),
    byLead: map(stats.byLead),
    byHour: map(stats.byHour),
    byStationHour: map(stats.byStationHour),
    byLeadLegacy: map(stats.byLeadLegacy),
    reliability: (stats.reliability || []).map(b => ({ lo:b.lo, hi:b.hi, n:b.n,
      stated: b.n ? +(b.sumStated/b.n).toFixed(3) : null,
      actual: b.n ? +(b.hits/b.n).toFixed(3) : null })),
    days: (stats.dates || []).length,
    updated: stats.updated,
  };
}

/** The rows a pass should append to the log, one per station. */
function logRows(snap) {
  const at = snap.ranAt;
  return snap.stations.filter(s => {
    if (s.error || !s.today) return false;
    const meta = STATIONS.find(x => x.id === s.station);
    return !meta || localDate(new Date(at), meta.tz) === s.today.date;
  }).map(s => {
    const peak = new Date(`${s.today.date}T${String(s.today.peakH).padStart(2, "0")}:00:00`);
    const leadH = +(((new Date(`${s.today.date}T23:59:00`) - new Date(at)) / 3600e3)).toFixed(1);
    // The station's local hour at call time, from its own timezone rather than
    // the run's wall clock: the same pass is 4am at KSFO and 7am at KNYC.
    const meta = STATIONS.find(x => x.id === s.station);
    const localH = meta ? localHour(new Date(at), meta.tz) : null;
    return { station: s.station, date: s.today.date, at, leadH, localH,
             point: s.today.point, pointBase: s.today.pointBase ?? null,
             sigma: s.today.sigma, i50: s.today.i50, i80: s.today.i80,
             top: s.today.top, obsMax: s.today.obsMax, regimeAdj: s.today.regimeAdj ?? null,
             tomorrow: s.tomorrow ? { date: s.tomorrow.date, point: s.tomorrow.point,
                                      pointBase: s.tomorrow.pointBase ?? null, sigma: s.tomorrow.sigma,
                                      i50: s.tomorrow.i50, i80: s.tomorrow.i80, top: s.tomorrow.top,
                                      conditions: s.tomorrow.conditions || null } : null };
  });
}

function dedupeModels(daily) {
  const sig = {}, keep = [], alias = {};
  for (const m of MODELS) {
    const arr = daily.byModel[m] || [];
    if (!arr.some(v => v != null)) continue;
    const s = arr.map(v => v == null ? "" : v.toFixed(2)).join(",");
    if (sig[s]) { alias[m] = sig[s]; continue; }
    sig[s] = m; keep.push(m);
  }
  return { keep, alias };
}

// ------------------------------------------------------------ calibration
/**
 * bias  : station CLI max  -  model ANALYSIS max   (grid-vs-sensor offset)
 * skill : station CLI max  -  model DAY-AHEAD max  (true forecast error)
 */
function calibrate(daily, prev, cliRows, today, models) {
  const cli = new Map(cliRows.map(r => [r.date, r.max]));
  const bias = {}, skillSigma = {}, skillBias = {}, nBias = {}, nSkill = {};
  const pooledBias = [], pooledSkill = [];

  for (const m of models) {
    const rb = [];
    daily.time.forEach((d, i) => {
      if (d >= today) return;
      const o = cli.get(d), v = num(daily.byModel[m][i]);
      if (o == null || v == null) return;
      rb.push(o - v);
    });
    nBias[m] = rb.length;
    if (rb.length >= 4) { bias[m] = median(rb); pooledBias.push(...rb); }

    const rs = [];
    const pm = prev && prev[m];
    if (pm) for (const [d, v] of Object.entries(pm)) {
      if (d >= today) continue;
      const o = cli.get(d);
      if (o == null || v == null) continue;
      rs.push(o - v);
    }
    nSkill[m] = rs.length;
    if (rs.length >= 5) {
      skillBias[m] = median(rs);
      skillSigma[m] = mad(rs) || 2.5;
      pooledSkill.push(...rs.map(x => x - skillBias[m]));
    }
  }

  const pb = pooledBias.length >= 4 ? median(pooledBias) : 0;
  const ps = pooledSkill.length >= 6 ? (mad(pooledSkill) || 2.6) : 2.6;
  for (const m of models) {
    if (bias[m] == null) bias[m] = pb;
    if (skillSigma[m] == null) skillSigma[m] = ps;
  }
  return { bias, skillSigma, skillBias, nBias, nSkill, pooledBias: pb, pooledSkillSigma: ps,
           nSkillDays: pooledSkill.length };
}

function hourIndex(time, prefix) {
  const idx = [];
  time.forEach((t, i) => { if (t.startsWith(prefix)) idx.push(i); });
  return idx;
}

/**
 * The maximum observed so far, and how precisely it is known.
 * A whole-degC 5-minute reading leaves ~+/-0.9 degF of slack; an hourly T-group
 * or a 6-hour remark group pins it to a tenth.
 */
/**
 * The 6-hour remark group reports the maximum over the synoptic period ending
 * at 00/06/12/18Z. That window only belongs to today if BOTH its ends fall on
 * today's local date -- the 06Z group, for instance, covers last evening on the
 * US east coast, and reading it as today's max quietly inflates the floor.
 */
function sixHourWindowInDay(obsTime, tz, day) {
  const syn = new Date(Math.round(obsTime.getTime() / 216e5) * 216e5);   // nearest 6h
  const startOk = climDate(new Date(syn.getTime() - 6 * 3600e3 + 60e3), tz) === day;
  const endOk   = climDate(new Date(syn.getTime() - 60e3), tz) === day;
  return startOk && endOk;
}

/**
 * The highest the station has actually REPORTED today.
 *
 * Only genuine station readings count. Points produced by inferSubHourly are
 * projections carried on a neighbour's movement, and at an hourly station the
 * newest of them can sit well above anything the station itself has sent --
 * KJRB runs several degrees hotter than Central Park on a sunny afternoon. A
 * projection recorded here would become a floor the forecast can never go
 * below, so a warm neighbour could erase a cool day's real maximum. They are
 * still kept for the drawn curve and for the current-temperature readout,
 * which is what they are for.
 */
function observedMax(series, tz, day) {
  const real = (series || []).filter(r => !r.inferred);
  const EMPTY = { max: null, precise: false, at: null, quantSd: 0,
                  loF: null, hiF: null, settles: null, quantized: false, source: null,
                  coarsePeak: null };
  if (!real.length) return EMPTY;

  // Keep precise and coarse evidence apart. A whole-degree C reading of c is
  // NOT a measurement of cToF(c): the truth sits anywhere in [c-0.5, c+0.5).
  // 89.6 is not an observation; it is 32C with the error hidden. Letting that
  // inflated number win a max comparison against a real tenths reading is how
  // a station gets called half a degree hot every day.
  let bp = null, bc = null;
  for (const r of real) {
    if (r.precise) { if (!bp || r.f > bp.f) bp = r; }
    else           { if (!bc || r.f > bc.f) bc = r; }
  }

  // ASOS computes its own maximum for each 6-hour window from 1-minute data
  // and transmits it at tenths. Where it covers the day it is authoritative,
  // so it is taken on its own merits and never gated on beating a coarse read.
  let sixF = null, sixAt = null;
  for (const r of real) {
    if (r.sixMaxC == null) continue;
    if (tz && day && !sixHourWindowInDay(r.t, tz, day)) continue;
    const f = cToF(r.sixMaxC);
    if (sixF == null || f > sixF) { sixF = f; sixAt = r.t; }
  }

  let max = null, precise = false, at = null, source = null;
  if (sixF != null) { max = sixF; precise = true; at = sixAt; source = "6-hour max group"; }
  if (bp && (max == null || bp.f > max)) { max = bp.f; precise = true; at = bp.t; source = "hourly tenths"; }

  // A coarse reading only proves a hotter moment if its ENTIRE band clears the
  // precise evidence. Otherwise it is consistent with what we already know.
  if (bc && (max == null || bc.f - 0.9 > max)) {
    max = bc.f; precise = false; at = bc.t; source = "5-minute whole degC";
  }
  if (max == null) return EMPTY;

  // Floor at what is actually known; carry remaining upside from any coarse
  // reading whose band reaches above that floor.
  let loF, hiF;
  if (precise) {
    loF = max;
    hiF = bc ? Math.max(max, +(bc.f + 0.89).toFixed(2)) : max;
  } else {
    loF = +(max - 0.9).toFixed(2);
    hiF = +(max + 0.89).toFixed(2);
  }
  const settles = [Math.round(loF), Math.round(hiF)];
  const quantized = (hiF - loF) > 0.2;

  // A whole-degree C observation is not precise enough to set the official high,
  // but it is informative about the next Fahrenheit settlement degree. Example:
  // a 22C OMO spans roughly 70.7-72.5F. If a precise 71.1F hourly T-group is
  // already known, the remaining compatible portion of that band puts substantial
  // mass on 72F. v3.9 carried the upper band but did not feed that information into
  // the degree distribution, which could leave KNYC biased toward 71 on days like
  // 2026-09-21.
  let coarsePeak = null;
  if (bc) {
    const cLo = bc.f - 0.9, cHi = bc.f + 0.89;
    const floor = precise ? Math.max(cLo, max) : cLo;
    const K = Math.round(precise ? max : cLo);
    const cut = K + 0.5;
    const denom = Math.max(0.01, cHi - floor);
    const p1 = clamp((cHi - Math.max(cut, floor)) / denom, 0, 1);
    coarsePeak = {
      f: bc.f, c: bc.c, at: bc.t, loF: +cLo.toFixed(2), hiF: +cHi.toFixed(2),
      floorF: +floor.toFixed(2), k: K, p1: +p1.toFixed(3), source: bc.source || (bc.omo ? "MADIS OMO" : "whole-degree C")
    };
  }
  return { max, precise, at, quantSd: quantized ? 0.52 : 0.15,
           loF, hiF, settles, quantized, source, coarsePeak };
}

/**
 * HIDDEN PEAKS AT AN HOURLY STATION (v3.9).
 *
 * Central Park sends one reading an hour. The CLI maximum comes from the
 * station's continuous record, so the true high often falls between readings.
 * The 6-hour maximum group recovers it, but only for windows that have closed
 * (reports at 11:51/17:51/23:51 UTC). Between the last such report and now,
 * the hourly readings are all there is, and they run low.
 *
 * Calibrated on KNYC 2022-01 -> 2026-09 (1,714 CLI days, IEM METAR archive),
 * at hourly cut-offs from late morning to midnight, on days where no later
 * hourly reading beat the running max. K = best max known so far (hourly
 * tenths or 6-hour group); g = K minus the highest hourly reading since the
 * last 6-hour report (that report's own reading included). Train 2022-01 ->
 * 2025-06, test 2025-07 -> 2026-09 agree to within a few points:
 *
 *   g = 0, readings either side as high or higher (plateau)   P(CLI >= K+1) 0.58
 *   g = 0, a sharp peak                                        P(CLI >= K+1) 0.37
 *   g = 1                                                      P(CLI >= K+1) 0.16
 *   g >= 2                                                     P(CLI >= K+1) 0.07
 *
 * For comparison: over whole days the hourly readings alone came in below the
 * CLI on 57% of days; with the 6-hour groups included, on 5.5%.
 *
 * Applied only once the segment's peak has passed (the latest reading is below
 * it) or the segment sits below K -- while the station is still rising, the
 * forecast's own upside already covers the next degree.
 */
const HIDDEN_PEAK = {
  plateau: { p1: 0.58, p2: 0.06 },
  sharp:   { p1: 0.37, p2: 0.03 },
  g1:      { p1: 0.16, p2: 0.017 },
  g2:      { p1: 0.07, p2: 0.017 },
};

function hiddenPeak(series, tz, day, K, sinceMs) {
  const real = (series || []).filter(r => !r.inferred && r.precise && r.f != null && climDate(r.t, tz) === day);
  if (!real.length || K == null) return null;
  // Start of the stretch no 6-hour group has covered yet (inclusive of that
  // report's reading, which is where the stretch begins).
  let segFrom = null;
  for (const r of real) {
    if (r.sixMaxC == null || !sixHourWindowInDay(r.t, tz, day)) continue;
    if (segFrom == null || r.t > segFrom) segFrom = r.t;
  }
  if (sinceMs != null && (segFrom == null || sinceMs > segFrom.getTime())) {
    // A preliminary CLI already accounts for everything up to its as-of time;
    // the stretch starts with the last reading before then.
    const before = real.filter(r => r.t.getTime() <= sinceMs);
    segFrom = before.length ? before[before.length - 1].t : new Date(sinceMs);
  }
  const seg = real.filter(r => segFrom == null || r.t >= segFrom);
  if (seg.length < 2) return null;
  const F = seg.map(r => Math.round(r.f));
  const segMax = Math.max(...F);
  const latest = F[F.length - 1];
  const g = K - segMax;
  if (g <= 0 && latest >= segMax) return { g: 0, rising: true, p1: 0, p2: 0, segFrom: segFrom && segFrom.toISOString(), segMax };
  let cls;
  if (g >= 2) cls = "g2";
  else if (g === 1) cls = "g1";
  else {
    const all = real.map(r => Math.round(r.f));
    const i = real.findIndex(r => (segFrom == null || r.t >= segFrom) && Math.round(r.f) === segMax);
    const prev = i > 0 ? all[i - 1] : null, next = i >= 0 && i < all.length - 1 ? all[i + 1] : null;
    cls = (prev != null && prev >= segMax) || (next != null && next >= segMax) ? "plateau" : "sharp";
  }
  return { g: Math.max(g, 0), cls, rising: false, ...HIDDEN_PEAK[cls], segFrom: segFrom && segFrom.toISOString(), segMax };
}

/** Mix integer distributions: [[dist, weight], ...] -> same shape as buildDist. */
function mixDists(parts) {
  const acc = new Map();
  for (const [d, w] of parts) { if (!(w > 0)) continue; for (const b of d.asc) acc.set(b.f, (acc.get(b.f) || 0) + b.p * w); }
  const asc = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([f, p]) => ({ f, p }));
  const tot = asc.reduce((s, b) => s + b.p, 0) || 1;
  for (const b of asc) b.p /= tot;
  const expected = asc.reduce((s, b) => s + b.f * b.p, 0);
  const ranked = asc.slice().sort((a, b) => b.p - a.p);
  const top = ranked.slice(0, 7).sort((a, b) => a.f - b.f);
  const modal = ranked.length ? ranked[0].f : Math.round(expected);
  const pick = q => { let c = 0; for (const b of asc) { c += b.p; if (c >= q - 1e-9) return b.f; } return asc[asc.length - 1].f; };
  return { asc, expected, top, modal, i50: [pick(0.25), pick(0.75)], i80: [pick(0.10), pick(0.90)] };
}

// -------------------------------------------------------------- the model
/** The integer-degree distribution in force, given a centre, a width and a floor. */
function buildDist(mu, sigma, floorK) {
  const lo = Math.max(floorK, Math.round(mu - 5 * sigma));
  const hi = Math.round(mu + 5 * sigma);
  const asc = []; let tot = 0;
  for (let k = lo; k <= hi; k++) {
    const p = normCdf((k + 0.5 - mu) / sigma) - normCdf((k - 0.5 - mu) / sigma);
    asc.push({ f: k, p }); tot += p;
  }
  if (tot > 0) for (const b of asc) b.p /= tot;
  // Report the mean of the distribution actually in force, not mu -- once the
  // floor truncates the low side, mu no longer sits in the middle of it.
  const expected = asc.reduce((s, b) => s + b.f * b.p, 0);
  const ranked = asc.slice().sort((a, b) => b.p - a.p);
  const top = ranked.slice(0, 7).sort((a, b) => a.f - b.f);
  const modal = ranked.length ? ranked[0].f : Math.round(mu);
  const pick = q => { let c = 0; for (const b of asc) { c += b.p; if (c >= q) return b.f; } return asc[asc.length - 1].f; };
  return { asc, expected, top, modal, i50: [pick(0.25), pick(0.75)], i80: [pick(0.10), pick(0.90)] };
}

function forecastDay(st, ctx, dayOffset) {
  const { daily, hourly, nbm, ens, cal, obsSeries, nowD, models } = ctx;
  const date = addDays(ctx.today, dayOffset);
  const di = daily.time.indexOf(date);
  const W = dayOffset === 0 ? W_D0 : W_D1;
  const nowH = localHour(nowD, st.tz);
  const hIdx = hourIndex(hourly.time, date);

  // --- what the station has already done today ----------------------------
  let obsMax = null, obsPrecise = false, obsMaxAt = null, quantSd = 0, current = null, trend = null;
  let currentInferred = false;
  let obsBand = null, obsSettles = null, obsQuantized = false, obsSource = null, coarsePeak = null;
  // Projections are fine for "what is it doing right now"; they are not
  // evidence about what the station has recorded, nor about how wrong a model
  // has been today.
  const realObs = obsSeries.filter(o => !o.inferred);
  if (dayOffset === 0 && obsSeries.length) {
    const om = observedMax(obsSeries, st.tz, date);
    obsMax = om.max; obsPrecise = om.precise; obsMaxAt = om.at; quantSd = om.quantSd;
    obsBand = om.loF == null ? null : [om.loF, om.hiF];
    obsSettles = om.settles; obsQuantized = om.quantized; obsSource = om.source; coarsePeak = om.coarsePeak;
    current = obsSeries[obsSeries.length - 1];
    currentInferred = !!(current && current.inferred);
    const back = obsSeries.filter(r => nowD - r.t <= 50 * 60e3);
    if (back.length >= 2) trend = back[back.length - 1].f - back[0].f;
  }
  // Today's preliminary CLI (e.g. "valid today as of 4 PM"): the station's own
  // ASOS maximum so far, so a hard floor -- and, unlike an hourly reading, it
  // has already caught any peak that fell between readings.
  let prelim = null;
  if (dayOffset === 0 && ctx.prelim && ctx.prelim.length) {
    const pr = ctx.prelim.find(r => r.date === date);
    if (pr) {
      const asOfMs = cliClockToUTC(date, pr.asOf, st.tz);
      prelim = { max: pr.max, maxTime: pr.maxTime, asOf: pr.asOf, issued: pr.issued,
                 asOfUTC: asOfMs ? new Date(asOfMs).toISOString() : null };
    }
  }
  // With a coarse reading the true value may sit up to ~0.9F above it.
  const obsFloor = obsMax == null ? null : obsMax - (obsPrecise ? 0.05 : 0.9);

  // --- per-model candidates ------------------------------------------------
  const perModel = [];
  for (const m of models) {
    const raw = di >= 0 ? num(daily.byModel[m][di]) : null;
    if (raw == null) continue;
    const b = cal.bias[m] || 0;
    let cand = raw + b, residual = null;

    if (dayOffset === 0 && realObs.length && hIdx.length) {
      // Today's running error, weighted toward the last few hours.
      const errs = [];
      for (const i of hIdx) {
        const h = +hourly.time[i].slice(11, 13);
        if (h > nowH) continue;
        const mv = num(hourly.byModel[m][i]);
        if (mv == null) continue;
        let near = null, best = Infinity;
        for (const o of realObs) {
          const d = Math.abs(localHour(o.t, st.tz) - h);
          if (d < best) { best = d; near = o; }
        }
        if (near && best <= 0.35) errs.push({ h, e: near.f - (mv + b) });
      }
      if (errs.length) {
        let sw = 0, sv = 0;
        for (const { h, e } of errs) { const w = Math.exp(-(nowH - h) / 3); sw += w; sv += e * w; }
        residual = sv / sw;
      }
      // Highest the model still reaches today, nudged by the decayed residual.
      let rem = null;
      for (const i of hIdx) {
        const h = +hourly.time[i].slice(11, 13);
        if (h < nowH - 0.5) continue;
        const mv = num(hourly.byModel[m][i]);
        if (mv == null) continue;
        const adj = mv + b + (residual == null ? 0 : residual * Math.exp(-(h - nowH) / 3));
        if (rem == null || adj > rem) rem = adj;
      }
      cand = rem == null ? cand : rem;
    }
    // Skill weighting: a model that has been wide of this station lately counts less.
    const wEff = (W[m] || 1) / (1 + (cal.skillSigma[m] || 2.6) / 4);
    perModel.push({ model:m, label:MODEL_LABEL[m], raw, bias:b, residual,
                    cand, value: obsFloor == null ? cand : Math.max(cand, obsFloor),
                    w: wEff, skillSd: cal.skillSigma[m] });
  }

  if (nbm[date] != null) {
    const cand = nbm[date] + cal.pooledBias;
    perModel.push({ model:"nbm", label:MODEL_LABEL.nbm, raw:nbm[date], bias:cal.pooledBias, residual:null,
                    cand, value: obsFloor == null ? cand : Math.max(cand, obsFloor),
                    w: (W.nbm || 1) / (1 + cal.pooledSkillSigma / 4), skillSd: cal.pooledSkillSigma });
  }
  if (!perModel.length) return null;

  // --- consensus -----------------------------------------------------------
  const cands = perModel.map(p => p.cand);              // unfloored: carries the real disagreement
  let mu = weightedMean(perModel.map(p => [p.value, p.w]));
  const med = median(perModel.map(p => p.value));
  if (mu != null && med != null) mu = 0.65 * mu + 0.35 * med;
  const muRaw = mu;

  // Analog term: what the day-ahead blend got wrong on past days whose sky and
  // wind looked like this one. Shrunk and capped; the unadjusted call is kept
  // so the scorecard can decide whether it is pulling its weight.
  const analog = analogAdjust(date, ctx.diag || {}, ctx.dayAheadErr || {}, { memory: ctx.memory || [] });
  let muBase = mu;
  mu = mu + analog.adj;

  if (obsFloor != null) { mu = Math.max(mu, obsFloor); muBase = Math.max(muBase, obsFloor); }
  if (obsMax != null && obsPrecise) { mu = Math.max(mu, obsMax); muBase = Math.max(muBase, obsMax); }
  if (prelim) { mu = Math.max(mu, prelim.max); muBase = Math.max(muBase, prelim.max); }
  const knownMax = prelim && (obsMax == null || prelim.max > obsMax) ? prelim.max : obsMax;

  // --- spread --------------------------------------------------------------
  const sSpread = Math.max(mad(cands) || 0, 0.4);

  let sEns = null; const ensMaxes = [];
  if (ens) {
    const shiftE = dstShiftH(date, st.tz);
    const ei = hourIndex(ens.time, date).filter(i => +ens.time[i].slice(11, 13) >= shiftE);
    for (const mem of ens.members) {
      const arr = ens.data[mem]; let mx = null;
      for (const i of ei) { const v = num(arr[i]); if (v != null && (mx == null || v > mx)) mx = v; }
      if (mx != null) ensMaxes.push(mx + cal.pooledBias);
    }
    if (ensMaxes.length > 8) sEns = mad(ensMaxes);
  }
  const sSkill = cal.pooledSkillSigma * (dayOffset === 0 ? 1.0 : 1.15);

  // --- how much of the day is still undecided ------------------------------
  let peakH = 15, peakVal = -Infinity;
  const shiftH = dstShiftH(date, st.tz);
  for (const i of hIdx) {
    if (+hourly.time[i].slice(11, 13) < shiftH) continue;     // that hour closed the previous climate day
    const vs = models.map(m => num(hourly.byModel[m][i])).filter(v => v != null);
    if (!vs.length) continue;
    const avg = vs.reduce((s, x) => s + x, 0) / vs.length;
    if (avg > peakVal) { peakVal = avg; peakH = +hourly.time[i].slice(11, 13); }
  }

  let shrink = 1, settled = false, upside = null;
  if (dayOffset === 0) {
    const ceil = Math.max(...cands);
    upside = knownMax == null ? null : Math.max(0, ceil - knownMax);
    // An hourly station's 50-minute trend is mostly the neighbours' projection;
    // once the models see no further rise and the peak hour is past, its
    // remaining uncertainty is the hidden-peak term, which is calibrated.
    const falling = (trend != null && trend < -0.4) || (!!st.hourlyOnly && trend != null && trend <= 0.4);
    if (knownMax != null && nowH > peakH + 1 && upside <= 0.4 && falling) { shrink = 0.12; settled = true; }
    else if (knownMax != null && nowH > peakH + 3 && upside <= 1.2 && falling) { shrink = 0.20; settled = true; }
    else {
      // Time left in the heating day, and how much rise is still expected --
      // whichever says "less certain" wins.
      const timeFac = clamp(0.28 + 0.72 * clamp((peakH - nowH + 1.5) / 7, 0, 1), 0.28, 1);
      const upFac   = upside == null ? 1 : clamp(0.30 + upside / 3.5, 0.30, 1.1);
      shrink = clamp(Math.max(timeFac, upFac), 0.28, 1.1);
    }
  }

  const core = Math.sqrt(0.40 * sSpread * sSpread + 0.25 * Math.pow(sEns ?? sSpread, 2) + 0.35 * sSkill * sSkill) * shrink;
  let sigma = Math.sqrt(core * core + quantSd * quantSd + 0.30 * 0.30);
  sigma = Math.max(sigma, 0.5);

  // --- distribution over whole degrees F -----------------------------------
  let floorK = obsMax == null ? -Infinity
             : (obsPrecise ? Math.round(obsMax) : Math.round(obsMax - 0.9));

  if (prelim && prelim.max > floorK) floorK = prelim.max;

  // Hourly-only station: the maximum so far may sit a degree above anything
  // reported (see HIDDEN_PEAK).
  let hidden = null;
  if (dayOffset === 0 && st.hourlyOnly && obsPrecise && isFinite(floorK)) {
    hidden = hiddenPeak(obsSeries, st.tz, date, floorK, prelim && prelim.asOfUTC ? Date.parse(prelim.asOfUTC) : null);
  }
  // After a preliminary CLI there may be too few readings since its as-of time
  // to form a stretch; the evening's residual risk is then the g >= 2 rate.
  if (dayOffset === 0 && st.hourlyOnly && prelim && !hidden && settled)
    hidden = { g: 2, cls: "g2", rising: false, ...HIDDEN_PEAK.g2, segFrom: prelim.asOfUTC, segMax: null };
  // Whole-degree C OMO/5-minute observations can contain settlement information
  // even when a lower tenths-resolution hourly reading is the precise maximum.
  // Treat the quantization geometry as a lower-resolution probability on K+1.
  // Do NOT add it to the hidden-peak probability (they are correlated views of
  // the same unseen peak); use the stronger of the two to avoid double counting.
  const coarseP1 = coarsePeak && coarsePeak.k === floorK ? coarsePeak.p1 : 0;
  const evidenceP1 = Math.max(hidden ? hidden.p1 : 0, coarseP1 || 0);
  const evidenceP2 = hidden ? hidden.p2 : 0;
  const degreeEvidence = evidenceP1 > 0 ? {
    p1: evidenceP1, p2: Math.min(evidenceP2, evidenceP1),
    hiddenP1: hidden ? hidden.p1 : 0, coarseP1: coarseP1 || 0,
    source: coarseP1 > (hidden ? hidden.p1 : 0) ? "quantized observation" : "hidden-peak calibration"
  } : null;

  let dist, distBase;
  if (degreeEvidence && settled) {
    // Peak passed and models see no further rise: observational degree evidence
    // dominates the residual distribution.
    const K = floorK, one = (k) => ({ asc: [{ f: k, p: 1 }] });
    const p1 = degreeEvidence.p1, p2 = degreeEvidence.p2;
    dist = distBase = mixDists([[one(K), 1 - p1], [one(K + 1), p1 - p2], [one(K + 2), p2]]);
  } else if (degreeEvidence) {
    const p1 = degreeEvidence.p1, p2 = degreeEvidence.p2;
    const w0 = 1 - p1, w1 = p1 - p2, w2 = p2;
    const at = (m, k) => buildDist(Math.max(m, k), sigma, k);
    dist = mixDists([[at(mu, floorK), w0], [at(mu, floorK + 1), w1], [at(mu, floorK + 2), w2]]);
    distBase = mixDists([[at(muBase, floorK), w0], [at(muBase, floorK + 1), w1], [at(muBase, floorK + 2), w2]]);
  } else {
    dist = buildDist(mu, sigma, floorK);
    distBase = buildDist(muBase, sigma, floorK);
  }
  const { asc, expected, top, modal, i50, i80 } = dist;

  // Confidence reflects the distribution actually in force: a tight sigma on a
  // day whose top degree is a coin flip is not "very high".
  const topP = Math.max(...asc.map(b => b.p));
  let conf = sigma < 1.0 ? "Very high" : sigma < 1.8 ? "High" : sigma < 3.0 ? "Moderate" : sigma < 4.5 ? "Low" : "Very low";
  const RANK = ["Very low", "Low", "Moderate", "High", "Very high"];
  const cap = topP < 0.55 ? "Moderate" : topP < 0.75 ? "High" : "Very high";
  if (RANK.indexOf(cap) < RANK.indexOf(conf)) conf = cap;
  if (degreeEvidence && degreeEvidence.p1 >= 0.1) settled = false;

  return {
    date, dayOffset, mu, muRaw, muBase, expected, sigma, conf, settled, peakH, upside, prelim, hidden, degreeEvidence,
    currentInferred,
    point: Math.round(expected), pointBase: Math.round(distBase.expected),
    regimeAdj: +analog.adj.toFixed(2), analog,
    conditions: (ctx.diag && ctx.diag[date]) || null,
    modal, i50, i80, buckets: asc, top,
    obsMax, obsPrecise, obsMaxAt, quantSd, current, trend,
    obsBand, obsSettles, obsQuantized, obsSource, coarsePeak,
    perModel: perModel.sort((a, b) => a.cand - b.cand),
    ensN: ensMaxes.length, sSpread, sEns, sSkill, shrink,
  };
}

// ---------------------------------------------------------- orchestration
async function runStation(st, cliCache, memory) {
  const nowD = new Date();
  const today = climDate(nowD, st.tz);

  const [cliRows, daily, hourly, prev, nbm, sun, dayObs, ens, cond] = await Promise.all([
    fetchCLI(st, cliCache).catch(() => []),
    fetchDaily(st),
    fetchHourly(st),
    fetchPrevRuns(st).catch(() => null),
    fetchNBM(st).catch(() => ({})),
    fetchSun(st).catch(() => null),
    fetchDayObs(st, nowD),
    fetchEnsemble(st).catch(() => null),
    fetchConditions(st).catch(() => null),
  ]);

  const { keep: models, alias } = dedupeModels(daily);
  const cal = calibrate(daily, prev, cliRows, today, models);

  let series = dayObs.obs.slice(), inferred = [];
  if (st.proxies.length) {
    inferred = inferSubHourly(dayObs.obs, dayObs.proxy);
    const lastReal = dayObs.obs.length ? dayObs.obs[dayObs.obs.length - 1].t : 0;
    series = series.concat(inferred.filter(r => r.t > lastReal)).sort((a, b) => a.t - b.t);
  }

  const diag = dailyDiagnostics(cond, st);

  // The day-ahead backtest is computed first: its errors are what the analog
  // term looks things up in.
  const cliMap = new Map(cliRows.map(r => [r.date, r]));
  const dates = [...new Set(Object.values(prev || {}).flatMap(o => Object.keys(o)))]
    .filter(d => d < today && cliMap.has(d)).sort().reverse().slice(0, 21);
  const dayAheadErr = {};
  const backtest = dates.map(d => {
    const pairs = models.map(m => {
      const v = prev && prev[m] && prev[m][d];
      if (v == null) return [null, 0];
      return [v + (cal.skillBias[m] ?? cal.bias[m] ?? 0), (W_D1[m] || 1) / (1 + (cal.skillSigma[m] || 2.6) / 4)];
    });
    const g = weightedMean(pairs);
    const actual = cliMap.get(d).max;
    if (g != null) dayAheadErr[d] = actual - g;          // signed: positive means the blend ran cold
    return { date: d, actual, called: g == null ? null : Math.round(g),
             err: g == null ? null : Math.round(g) - actual, maxTime: cliMap.get(d).maxTime };
  });

  const ctx = { today, daily, hourly, nbm, ens, cal, obsSeries: series, nowD, models, diag, dayAheadErr,
                prelim: cliRows.prelim || [],
                memory: memory || [] };
  const d0 = forecastDay(st, ctx, 0);
  const d1 = forecastDay(st, ctx, 1);
  const errs = backtest.map(b => b.err).filter(e => e != null);
  const mae = errs.length ? errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length : null;
  const within1 = errs.length ? errs.filter(e => Math.abs(e) <= 1).length / errs.length : null;
  const within2 = errs.length ? errs.filter(e => Math.abs(e) <= 2).length / errs.length : null;

  return {
    station: st.id, name: st.name, site: st.site, tz: st.tz, caveat: st.caveat || null,
    localDate: today, localClock: localClock(nowD, st.tz), localHour: localHour(nowD, st.tz),
    sunrise: sun && sun.daily ? sun.daily.sunrise[1] : null,
    sunset:  sun && sun.daily ? sun.daily.sunset[1]  : null,
    obs: dayObs.obs.map(r => ({ t: r.t.toISOString(), f: r.f, precise: r.precise, source: r.source || null, omo: !!r.omo })),
    inferredObs: inferred.map(r => ({ t: r.t.toISOString(), f: r.f })),
    obsCadenceMin: dayObs.obs.length > 2
      ? Math.round((dayObs.obs[dayObs.obs.length-1].t - dayObs.obs[0].t) / 60e3 / (dayObs.obs.length - 1)) : null,
    today: d0, tomorrow: d1, cal, aliasedModels: alias, activeModels: models, diag,
    cli: cliRows.slice(0, 14), backtest, mae, within1, within2,
    memoryDays: (memory || []).length, modelVersion: MODEL_VERSION,
    ranAt: new Date().toISOString(),
  };
}

async function runAll(onProgress, regime, cache) {
  const cliCache = cache || new Map();
  const out = [];
  for (const st of STATIONS) {
    if (onProgress) onProgress(st.id, "start");
    try { out.push(await runStation(st, cliCache, (regime || {})[st.id] || [])); }
    catch (e) { out.push({ station: st.id, name: st.name, site: st.site, error: String((e && e.message) || e) }); }
    if (onProgress) onProgress(st.id, "done");
  }
  return { ranAt: new Date().toISOString(), stations: out };
}

/**
 * One complete pass: forecast, then settle and score whatever the stations have
 * since reported. `prevStats` and `pending` come from storage; the caller writes
 * back everything this returns.
 *
 * Scoring is driven by removing rows from `pending` once they settle, so a call
 * can never be counted twice however often this runs.
 */
async function passWithScoring(prevStats, pending, opts = {}) {
  const res = await runAll(opts.onProgress, opts.regime, opts.cliCache);
  const snap = snapshot(res, { maxCurve: opts.maxCurve || 40 });

  const settled = {};
  for (const s of snap.stations) {
    if (s.error) continue;
    for (const c of (s.cli || [])) settled[`${s.station}|${c.d}`] = c.max;
  }

  let stats = (prevStats && prevStats.overall) ? prevStats : emptyStats();
  const scoredDates = new Set();
  const scoredRows = [];
  const regimeRows = [];
  const stillPending = [];
  const horizon = addDays(new Date().toISOString().slice(0, 10), -7);

  for (const row of (pending || [])) {
    // (a) the same-day call, once that date settles
    if (!row._scored) {
      const truth = settled[`${row.station}|${row.date}`];
      if (truth != null) {
        scoredRows.push(...scoreCalls([row], truth));
        scoredDates.add(row.date);
        row._scored = true;
      }
    }
    // (b) the day-ahead call inside it, once ITS date settles -- this is what
    //     feeds the analog, and it is a genuine day-ahead lead time
    if (!row._regime && row.tomorrow && row.tomorrow.conditions) {
      const tTruth = settled[`${row.station}|${row.tomorrow.date}`];
      if (tTruth != null) {
        const c = row.tomorrow.conditions;
        regimeRows.push({ station: row.station, d: row.tomorrow.date,
                          cloud: c.cloud, onshore: c.onshore, rad: c.rad, blh: c.blh,
                          precip: c.precip ?? null, dew: c.dew ?? null, rh: c.rh ?? null,
                          err: tTruth - row.tomorrow.point });   // positive: the call ran cold
        row._regime = true;
      }
    }
    const done = row._scored && (!row.tomorrow || row._regime);
    if (!done && row.date >= horizon) stillPending.push(row);
  }
  if (scoredRows.length) {
    stats = accumulate(stats, scoredRows);                 // no date key: pending removal is the guard
    stats.dates = [...new Set([...(stats.dates || []), ...scoredDates])].sort().slice(-400);
    stats.updated = new Date().toISOString();
  }
  // A logic change makes older scores a different model's record. Note it rather
  // than silently pooling across versions.
  if (stats.modelVersion && stats.modelVersion !== MODEL_VERSION) {
    stats.versionChanges = [...(stats.versionChanges || []),
      { at: new Date().toISOString(), from: stats.modelVersion, to: MODEL_VERSION, atCalls: stats.overall.n }].slice(-20);
  }
  stats.modelVersion = MODEL_VERSION;

  // today's calls join the queue for tomorrow's settlement
  for (const row of logRows(snap)) stillPending.push(row);

  snap.scorecard = finalizeStats(stats);
  if (opts.morning) {
    // Carries what tomorrow's prior-day report needs to grade this call: the
    // date it applies to, the unadjusted call for the analog comparison, the
    // distribution for the probability it put on the degree that settles, and
    // the conditions that produced it.
    snap.morning = { at: snap.ranAt, calls: snap.stations.map(s => s.error
      ? { station: s.station, error: true }
      : { station: s.station, date: s.today.date, point: s.today.point,
          pointBase: s.today.pointBase ?? null, i80: s.today.i80, i50: s.today.i50,
          sigma: s.today.sigma, conf: s.today.conf, top: s.today.top,
          regimeAdj: s.today.regimeAdj ?? null,
          analog: s.today.analog || null, conditions: s.today.conditions || null,
          tomorrow: s.tomorrow ? s.tomorrow.point : null,
          tomorrowDate: s.tomorrow ? s.tomorrow.date : null,
          tomorrowI80: s.tomorrow ? s.tomorrow.i80 : null }) };
  } else if (opts.morning === false && opts.carryMorning) {
    snap.morning = opts.carryMorning;
  }

  // The prior morning's calls, graded against what the stations went on to
  // report. Kept separate from the scorecard: the scorecard pools every lead
  // time into running statistics, whereas this is the one comparison that can
  // be checked by eye -- the 7am call, the number it settled on, the gap.
  let priorReport = null;
  if (opts.priorMorning && Array.isArray(opts.priorMorning.calls)) {
    priorReport = priorDayReport(opts.priorMorning, settled, snap);
  }
  // Whether or not this pass built one, the most recent stored report is
  // attached, so a peak-window pass does not blank the dashboard's morning
  // review just by being the latest writer.
  const reportsAfter = mergeReports(opts.reports || [], priorReport);
  const newest = reportsAfter.length ? reportsAfter[reportsAfter.length - 1] : null;
  if (newest) {
    snap.priorDay = newest;
    snap.priorDayHistory = reportHistory(reportsAfter);
  }

  return { snap, stats, pending: stillPending, regimeRows, reports: reportsAfter,
           priorReport, scoredCount: scoredRows.length, scoredDates: [...scoredDates] };
}

/**
 * Grade the previous morning's calls against what settled.
 *
 * Deliberately reports the analog term's contribution per station rather than
 * only the error: knowing the call missed by 2F is less useful than knowing
 * whether the regime adjustment pushed it toward or away from the truth, since
 * that is the part of the model still being decided.
 *
 * Tolerates the thinner morning block written by v3.3 -- those rows have no
 * date, no unadjusted call and no conditions, so the report falls back to the
 * run timestamp for the date and simply omits what it cannot know.
 */
function priorDayReport(prior, settled, snap) {
  const fallbackDate = (prior.at || "").slice(0, 10);
  const rows = [];
  for (const c of prior.calls) {
    if (!c || c.error || c.point == null) continue;
    const date = c.date || fallbackDate;
    if (!date) continue;
    const actual = settled[`${c.station}|${date}`];
    const cond = c.conditions || null;
    const row = {
      station: c.station, date, call: c.point, i80: c.i80 || null, conf: c.conf || null,
      actual: actual == null ? null : actual,
      pending: actual == null,
      conditions: cond,
      wet: cond ? (cond.precip == null ? null : WET_LABEL[wetClass(cond.precip)]) : null,
      regimeAdj: c.regimeAdj ?? null,
      analogReason: c.analog ? (c.analog.reason || null) : null,
      analogTrust: c.analog && c.analog.trust != null ? c.analog.trust : null,
      dayAheadForToday: c.tomorrow ?? null,
      dayAheadI80: c.tomorrowI80 || null,
    };
    if (actual != null) {
      row.err = c.point - actual;
      row.absErr = Math.abs(row.err);
      row.inside80 = c.i80 ? (actual >= c.i80[0] && actual <= c.i80[1]) : null;
      row.inside50 = c.i50 ? (actual >= c.i50[0] && actual <= c.i50[1]) : null;
      if (c.top) {
        const hit = c.top.find(b => b.f === actual);
        row.pTruth = +((hit ? hit.p : 0)).toFixed(3);
      }
      if (c.pointBase != null) {
        row.callBase = c.pointBase;
        row.errBase = c.pointBase - actual;
        // null when the analog did not move the call at all
        row.analogHelped = c.pointBase === c.point ? null
                         : Math.abs(row.err) < Math.abs(row.errBase);
      }
    }
    rows.push(row);
  }
  const done = rows.filter(r => r.actual != null);
  const withBase = done.filter(r => r.analogHelped != null);
  return {
    at: prior.at || null,
    forDate: rows.length ? rows[0].date : null,
    rows,
    n: done.length,
    awaiting: rows.filter(r => r.pending).map(r => r.station),
    mae: done.length ? +(done.reduce((s, r) => s + r.absErr, 0) / done.length).toFixed(2) : null,
    bias: done.length ? +(done.reduce((s, r) => s + r.err, 0) / done.length).toFixed(2) : null,
    cover80: done.length ? +(done.filter(r => r.inside80).length / done.length).toFixed(2) : null,
    within1: done.length ? +(done.filter(r => r.absErr <= 1).length / done.length).toFixed(2) : null,
    exact: done.filter(r => r.absErr === 0).length,
    analogHelped: withBase.length ? withBase.filter(r => r.analogHelped).length : null,
    analogMoved: withBase.length,
  };
}

/* ------------------------------------------------ browser-held queue ---- */
/**
 * Calls waiting on settlement are parked in the browser's own storage rather
 * than shuttled back and forth, which keeps a scheduled run cheap. The running
 * statistics are small and stay in the artifact database, so clearing site data
 * costs at most a day of scoring, never the history.
 */
const PEND_KEY = "ht.pending.v1";
function loadPending() {
  try { const v = JSON.parse(localStorage.getItem(PEND_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function savePending(rows) {
  try { localStorage.setItem(PEND_KEY, JSON.stringify(rows)); return true; } catch (e) { return false; }
}

/** One pass, with the pending queue handled for you. Returns only what the caller must store. */
async function passAuto(prevStats, opts = {}) {
  const pending = loadPending();
  const regimeBefore = loadRegime();
  const reportsBefore = loadReports();
  const out = await passWithScoring(prevStats, pending,
    { ...opts, regime: regimeBefore, reports: reportsBefore });
  const regimeAfter = mergeRegime(regimeBefore, out.regimeRows);
  const savedPend = savePending(out.pending);
  const savedReg = saveRegime(regimeAfter);
  const savedRep = saveReports(out.reports || []);
  out.snap.regime = { counts: regimeCount(regimeAfter), added: out.regimeRows.length,
                      persisted: savedReg, modelVersion: MODEL_VERSION };
  return { snap: out.snap, stats: out.stats,
           scoredCount: out.scoredCount, scoredDates: out.scoredDates,
           regimeAdded: out.regimeRows.length, regimeCounts: regimeCount(regimeAfter),
           pendingCount: out.pending.length, pendingPersisted: savedPend, regimePersisted: savedReg,
           priorDayBuilt: !!out.priorReport, priorDayStored: (out.reports || []).length,
           priorDayPersisted: savedRep,
           queueWasEmpty: pending.length === 0 };
}

/** Compact form for the hosted mirror and the morning push. */
function decimate(rows, maxN, keyFn) {
  if (!maxN || rows.length <= maxN) return rows;
  // keep the endpoints and the warmest reading, then thin the rest evenly
  const keepIdx = new Set([0, rows.length - 1]);
  let hot = 0;
  rows.forEach((r, i) => { if (keyFn(r) > keyFn(rows[hot])) hot = i; });
  keepIdx.add(hot);
  const stride = rows.length / (maxN - keepIdx.size);
  for (let i = 0; i < rows.length; i += stride) keepIdx.add(Math.floor(i));
  return [...keepIdx].sort((a, b) => a - b).map(i => rows[i]);
}

/**
 * The only form in which an observed maximum should be quoted. When the reading
 * is a whole-degree C conversion it is a range and says so; when a T-group or a
 * six-hour group has pinned it, it is a number and says where it came from.
 */
function obsLabel(d) {
  if (!d || d.obsMax == null) return null;
  if (!d.obsQuantized) return `${d.obsMax.toFixed(2)}F -> ${Math.round(d.obsMax)} (${d.obsSource || "observed"})`;
  const band = d.obsBand || [d.obsMax - 0.9, d.obsMax + 0.89];
  const st = d.obsSettles || [];
  return `${band[0].toFixed(1)}-${band[1].toFixed(1)}F, unresolved`
       + (st.length ? ` (settles ${st[0] === st[1] ? st[0] : st[0] + " or " + st[1]})` : "");
}

function localHM(iso, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(iso));
}

function snapshot(result, opts = {}) {
  const maxCurve = opts.maxCurve || 0;
  const day = d => d && ({
    date: d.date, point: d.point, modal: d.modal, sigma: +d.sigma.toFixed(2),
    conf: d.conf, settled: d.settled, i50: d.i50, i80: d.i80, peakH: d.peakH,
    upside: d.upside == null ? null : +d.upside.toFixed(1),
    obsMax: d.obsMax == null ? null : +d.obsMax.toFixed(1), obsPrecise: d.obsPrecise,
    obsBand: d.obsBand || null, obsSettles: d.obsSettles || null,
    obsQuantized: !!d.obsQuantized, obsSource: d.obsSource || null,
    obsMaxLabel: obsLabel(d),
    coarsePeak: d.coarsePeak ? { f:+d.coarsePeak.f.toFixed(1), c:d.coarsePeak.c, at:d.coarsePeak.at ? d.coarsePeak.at.toISOString() : null,
                                 loF:d.coarsePeak.loF, hiF:d.coarsePeak.hiF, floorF:d.coarsePeak.floorF,
                                 k:d.coarsePeak.k, p1:d.coarsePeak.p1, source:d.coarsePeak.source } : null,
    degreeEvidence: d.degreeEvidence || null,
    prelim: d.prelim || null,
    hidden: d.hidden ? { p1: d.hidden.p1, p2: d.hidden.p2, g: d.hidden.g, cls: d.hidden.cls || null,
                         rising: !!d.hidden.rising, segFrom: d.hidden.segFrom, segMax: d.hidden.segMax } : null,
    current: d.current ? +d.current.f.toFixed(1) : null,
    currentInferred: !!d.currentInferred,
    trend: d.trend == null ? null : +d.trend.toFixed(1),
    top: d.top.map(b => ({ f: b.f, p: +b.p.toFixed(3) })),
    models: d.perModel.map(m => ({ m: m.label, v: +m.cand.toFixed(1), b: +m.bias.toFixed(1) })),
    pointBase: d.pointBase, regimeAdj: d.regimeAdj,
    analog: d.analog ? { n: d.analog.n, effN: d.analog.effN, raw: d.analog.raw == null ? null : +d.analog.raw.toFixed(1),
                         shrunk: d.analog.shrunk ?? null, sim: d.analog.sim ?? null,
                         trust: d.analog.trust ?? null, dims: d.analog.dims || null,
                         wet: d.analog.wet == null ? null : WET_LABEL[d.analog.wet],
                         wetPool: d.analog.wetPool ?? null,
                         days: d.analog.days, reason: d.analog.reason } : null,
    conditions: d.conditions ? {
      cloud: d.conditions.cloud == null ? null : Math.round(d.conditions.cloud),
      rad: d.conditions.rad == null ? null : Math.round(d.conditions.rad),
      windDir: d.conditions.windDir == null ? null : Math.round(d.conditions.windDir),
      windSpd: d.conditions.windSpd == null ? null : +d.conditions.windSpd.toFixed(1),
      onshore: d.conditions.onshore == null ? null : +d.conditions.onshore.toFixed(2),
      dew: d.conditions.dew == null ? null : Math.round(d.conditions.dew),
      rh: d.conditions.rh == null ? null : Math.round(d.conditions.rh),
      precip: d.conditions.precip == null ? null : +d.conditions.precip.toFixed(2),
      blh: d.conditions.blh == null ? null : Math.round(d.conditions.blh),
    } : null,
  });
  return {
    ranAt: result.ranAt,
    stations: result.stations.map(s => s.error ? { station: s.station, error: s.error } : ({
      station: s.station, name: s.name, site: s.site, localDate: s.localDate,
      localClock: s.localClock, caveat: s.caveat, obsCadenceMin: s.obsCadenceMin,
      today: day(s.today), tomorrow: day(s.tomorrow),
      curve: decimate(s.obs || [], maxCurve, o => o.f).map(o => [localHM(o.t, s.tz), +o.f.toFixed(1)]),
      inferredCurve: decimate((s.inferredObs || []).filter((_, i) => i % 3 === 0), maxCurve, o => o.f).map(o => [localHM(o.t, s.tz), +o.f.toFixed(1)]),
      cli: (s.cli || []).slice(0, 6).map(c => ({ d: c.date, max: c.max, at: c.maxTime })),
      backtest: (s.backtest || []).slice(0, 10), mae: s.mae == null ? null : +s.mae.toFixed(2),
      within1: s.within1, within2: s.within2,
      skillDays: s.cal.nSkillDays, skillSd: +s.cal.pooledSkillSigma.toFixed(2),
      memoryDays: s.memoryDays || 0, modelVersion: s.modelVersion || null,
      bias: Object.fromEntries(Object.entries(s.cal.bias).map(([k, v]) => [MODEL_LABEL[k] || k, +v.toFixed(1)])),
    })),
  };
}

return { STATIONS, MODELS, MODEL_LABEL, runAll, runStation, snapshot, parseCLI,
         fetchConditions, dailyDiagnostics, analogAdjust, buildDist,
         scoreCalls, aggregateScores, logRows, leadBucket,
         emptyStats, accumulate, finalizeStats, passWithScoring, passAuto, loadPending, savePending,
         loadRegime, saveRegime, mergeRegime, regimeCount, MODEL_VERSION,
         wetClass, WET_LABEL, priorDayReport, ANALOG_DIMS, ANALOG_Z2_CAP,
         loadReports, saveReports, mergeReports, reportHistory,
         sixHourMaxC, tGroupC, fetchMetars, fetchObs, observedMax, obsLabel, loadMadisOMOFile,
         sixHourWindowInDay, localHM, localDate, climDate, localHour, localClock, addDays, median, mad, normCdf };
})();

if (typeof module !== "undefined") module.exports = HT;

if (typeof window !== "undefined") window.HT = HT;

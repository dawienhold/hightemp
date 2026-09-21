#!/usr/bin/env node
/* ============================================================================
   NFL game-time rain outlook, run by GitHub Actions (.github/workflows/nfl.yml).

   1. Schedule   ESPN's public scoreboard feed: every game kicking off in the
                 next 5 days, and always through the coming Monday night game
                 so Sunday's slate is visible all week. Games more than 5 days
                 out are flagged `early` (less reliable). Games in progress stay.
   2. Location   A stadium table below (coordinates + roof type). Neutral-site
                 and international games fall back to a table of known venues,
                 then to Open-Meteo's geocoder on the venue's city.
   3. Rain       Open-Meteo ensembles (GFS 31 members + ECMWF 51 members). For
                 each member, look at the hours the game is played
                 (kickoff to kickoff + 3.5 h):
                   any rain   game total >= 0.01 in (0.25 mm), the same
                              threshold the NWS uses for "chance of rain"
                   moderate+  peak hourly rate >= 0.10 in/h (2.5 mm/h)
                   heavy      peak hourly rate >= 0.30 in/h (7.6 mm/h)
                 The share of members that meet each test is the probability.

   Writes one file, docs/data/nfl.json, overwritten every run. No history is
   kept. If the schedule can't be fetched the old file is left in place and the
   run fails, so the page keeps showing the last good numbers with their age.
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "docs", "data", "nfl.json");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const OMENS = "https://ensemble-api.open-meteo.com/v1/ensemble";
const GEO = "https://geocoding-api.open-meteo.com/v1/search";

const WINDOW_DAYS = 5;          // forecasts inside this are the reliable ones
const GAME_HOURS = 3.5;
const MODELS = [
  { id: "gfs025", label: "GFS" },
  { id: "ecmwf_ifs025", label: "ECMWF" },
];
const MM = { any: 0.25, moderate: 2.5, heavy: 7.6 };   // thresholds, millimetres
const SNOW_F = 34;                                      // at/below: may fall as snow

// Roof: "open" | "retractable" (forecast shown, roof may close) | "dome" | "covered"
// (fixed roof, no rain on the field). Keyed by ESPN team abbreviation.
const HOME = {
  ARI: ["State Farm Stadium", "Glendale", 33.5276, -112.2626, "retractable"],
  ATL: ["Mercedes-Benz Stadium", "Atlanta", 33.7554, -84.4008, "retractable"],
  BAL: ["M&T Bank Stadium", "Baltimore", 39.2780, -76.6227, "open"],
  BUF: ["Highmark Stadium", "Orchard Park", 42.7738, -78.7870, "open"],
  CAR: ["Bank of America Stadium", "Charlotte", 35.2258, -80.8528, "open"],
  CHI: ["Soldier Field", "Chicago", 41.8623, -87.6167, "open"],
  CIN: ["Paycor Stadium", "Cincinnati", 39.0955, -84.5161, "open"],
  CLE: ["Huntington Bank Field", "Cleveland", 41.5061, -81.6995, "open"],
  DAL: ["AT&T Stadium", "Arlington", 32.7473, -97.0945, "retractable"],
  DEN: ["Empower Field at Mile High", "Denver", 39.7439, -105.0201, "open"],
  DET: ["Ford Field", "Detroit", 42.3400, -83.0456, "dome"],
  GB:  ["Lambeau Field", "Green Bay", 44.5013, -88.0622, "open"],
  HOU: ["NRG Stadium", "Houston", 29.6847, -95.4107, "retractable"],
  IND: ["Lucas Oil Stadium", "Indianapolis", 39.7601, -86.1639, "retractable"],
  JAX: ["EverBank Stadium", "Jacksonville", 30.3239, -81.6373, "open"],
  KC:  ["GEHA Field at Arrowhead Stadium", "Kansas City", 39.0489, -94.4839, "open"],
  LV:  ["Allegiant Stadium", "Las Vegas", 36.0909, -115.1833, "dome"],
  LAC: ["SoFi Stadium", "Inglewood", 33.9535, -118.3392, "covered"],
  LAR: ["SoFi Stadium", "Inglewood", 33.9535, -118.3392, "covered"],
  MIA: ["Hard Rock Stadium", "Miami Gardens", 25.9580, -80.2389, "open"],
  MIN: ["U.S. Bank Stadium", "Minneapolis", 44.9737, -93.2577, "dome"],
  NE:  ["Gillette Stadium", "Foxborough", 42.0909, -71.2643, "open"],
  NO:  ["Caesars Superdome", "New Orleans", 29.9511, -90.0812, "dome"],
  NYG: ["MetLife Stadium", "East Rutherford", 40.8135, -74.0745, "open"],
  NYJ: ["MetLife Stadium", "East Rutherford", 40.8135, -74.0745, "open"],
  PHI: ["Lincoln Financial Field", "Philadelphia", 39.9008, -75.1675, "open"],
  PIT: ["Acrisure Stadium", "Pittsburgh", 40.4468, -80.0158, "open"],
  SF:  ["Levi's Stadium", "Santa Clara", 37.4030, -121.9700, "open"],
  SEA: ["Lumen Field", "Seattle", 47.5952, -122.3316, "open"],
  TB:  ["Raymond James Stadium", "Tampa", 27.9759, -82.5033, "open"],
  TEN: ["Nissan Stadium", "Nashville", 36.1665, -86.7713, "open"],
  WSH: ["Northwest Stadium", "Landover", 38.9078, -76.8645, "open"],
};
HOME.WAS = HOME.WSH;

// Neutral / international venues, matched on the venue name ESPN reports.
const NEUTRAL = [
  [/tottenham/i, "London", 51.6043, -0.0664, "open"],
  [/wembley/i, "London", 51.5560, -0.2796, "open"],
  [/allianz arena/i, "Munich", 48.2188, 11.6247, "open"],
  [/deutsche bank park|waldstadion/i, "Frankfurt", 50.0686, 8.6455, "retractable"],
  [/olympiastadion/i, "Berlin", 52.5147, 13.2395, "open"],
  [/bernab[eé]u/i, "Madrid", 40.4531, -3.6883, "retractable"],
  [/stade de france/i, "Saint-Denis", 48.9245, 2.3602, "open"],
  [/maracan[aã]/i, "Rio de Janeiro", -22.9122, -43.2302, "open"],
  [/neo qu[ií]mica|corinthians/i, "São Paulo", -23.5453, -46.4742, "open"],
  [/melbourne cricket|\bmcg\b/i, "Melbourne", -37.8200, 144.9834, "open"],
  [/azteca|estadio banorte/i, "Mexico City", 19.3029, -99.1505, "open"],
  [/croke park/i, "Dublin", 53.3607, -6.2512, "open"],
];

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const round = (x, d = 0) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

async function getJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const opt = { headers: { Accept: "application/json", "User-Agent": "hightemp-nfl (github.com/dawienhold/hightemp)" } };
      if (AbortSignal.timeout) opt.signal = AbortSignal.timeout(30000);
      const r = await fetch(url, opt);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url.split("?")[0]);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

const ymdET = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(d).replace(/-/g, "");

// ---------------------------------------------------------------- schedule
/** Later of: 5 days from now, or the end of the coming Sunday's week — the
 *  first Tuesday 10:00 UTC (~6 AM Eastern, after Monday night) that is more
 *  than a day away. From Monday morning on, that means next week's slate. */
function windowEnd(now) {
  const t = new Date(now);
  const tue = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 10));
  while (tue.getUTCDay() !== 2 || +tue <= +now + 86400e3) tue.setUTCDate(tue.getUTCDate() + 1);
  return Math.max(+now + WINDOW_DAYS * 86400e3, +tue);
}

async function fetchSchedule(now) {
  // ESPN rejects date ranges on this feed, so ask one Eastern day at a time,
  // starting yesterday (catches a late game still running past midnight).
  const events = new Map();
  const hi = windowEnd(now);
  const days = Math.ceil((hi - +now) / 86400e3);
  for (let i = -1; i <= days + 1; i++) {
    const day = ymdET(new Date(+now + i * 86400e3));
    const d = await getJSON(`${ESPN}?dates=${day}`);
    if (!d || !Array.isArray(d.events)) throw new Error("ESPN: unexpected response for " + day);
    for (const ev of d.events) events.set(String(ev.id), ev);
  }
  const lo = +now - GAME_HOURS * 3600e3;
  const games = [];
  for (const ev of events.values()) {
    const kick = new Date(ev.date);
    if (isNaN(+kick) || +kick < lo || +kick > hi) continue;
    const comp = (ev.competitions || [])[0] || {};
    const state = ((ev.status || comp.status || {}).type || {}).state || "pre";
    if (state === "post") continue;
    const side = (h) => (comp.competitors || []).find((c) => c.homeAway === h) || {};
    const team = (c) => ({
      abbr: (c.team || {}).abbreviation || "",
      name: (c.team || {}).displayName || (c.team || {}).name || "",
      short: (c.team || {}).shortDisplayName || (c.team || {}).name || "",
    });
    const v = comp.venue || {};
    const a = v.address || {};
    games.push({
      id: String(ev.id),
      kickoff: kick.toISOString(),
      state,
      detail: ((ev.status || {}).type || {}).shortDetail || "",
      home: team(side("home")),
      away: team(side("away")),
      neutral: !!comp.neutralSite,
      espnVenue: { name: v.fullName || "", city: a.city || "", state: a.state || "", country: a.country || "", indoor: v.indoor },
      tv: ((comp.broadcasts || [])[0] || {}).names?.join(", ") || "",
    });
  }
  games.sort((x, y) => x.kickoff.localeCompare(y.kickoff) || x.id.localeCompare(y.id));
  return games;
}

// ---------------------------------------------------------------- location
const geoCache = new Map();
async function geocode(city, country) {
  const key = city + "|" + country;
  if (geoCache.has(key)) return geoCache.get(key);
  let hit = null;
  try {
    const d = await getJSON(`${GEO}?name=${encodeURIComponent(city)}&count=5&language=en&format=json`);
    const rs = (d && d.results) || [];
    hit = rs.find((r) => country && norm(r.country).includes(norm(country).slice(0, 5))) || rs[0] || null;
  } catch (e) { hit = null; }
  geoCache.set(key, hit);
  return hit;
}

async function locate(g) {
  const ev = g.espnVenue;
  const place = (name, city, lat, lon, roof, how) => ({
    name, city: city + (ev.state && how !== "neutral-table" ? ", " + ev.state : ev.country && ev.country !== "USA" ? ", " + ev.country : ""),
    lat, lon, roof, how,
  });
  const h = HOME[g.home.abbr];
  const cityMatch = h && ev.city && norm(ev.city).slice(0, 5) === norm(h[1]).slice(0, 5);
  const nameMatch = h && ev.name && norm(ev.name).includes(norm(h[0]).slice(0, 8));
  if (h && (cityMatch || nameMatch || (!ev.city && !g.neutral))) {
    return place(ev.name || h[0], h[1], h[2], h[3], h[4], "home-table");
  }
  for (const [re, city, lat, lon, roof] of NEUTRAL) {
    if (re.test(ev.name)) return place(ev.name, city, lat, lon, roof, "neutral-table");
  }
  // Some other US stadium: if it's another team's home, use that entry.
  for (const [, v] of Object.entries(HOME)) {
    if (ev.name && norm(ev.name).includes(norm(v[0]).slice(0, 8))) return place(ev.name, v[1], v[2], v[3], v[4], "home-table");
  }
  if (ev.city) {
    const r = await geocode(ev.city, ev.country);
    if (r) return place(ev.name || ev.city, ev.city, r.latitude, r.longitude, ev.indoor ? "dome" : "open", "geocoded");
  }
  if (h) return place(h[0], h[1], h[2], h[3], h[4], "home-table");
  return null;
}

// ---------------------------------------------------------------- weather
/**
 * Pull every precipitation series out of one ensemble response and turn each
 * into an hourly RATE. Open-Meteo reports precipitation as the sum over the
 * preceding hour; where a model only has 3- or 6-hourly steps the in-between
 * hours may be null, in which case the sum at the next step is spread evenly
 * over the hours it covers.
 */
function seriesFrom(d) {
  const hr = (d && d.hourly) || {};
  const t = hr.time || [];
  const precip = [], temp = [];
  for (const [k, arr] of Object.entries(hr)) {
    if (!Array.isArray(arr) || arr.length !== t.length) continue;
    if (/^precipitation/.test(k)) {
      const out = new Array(arr.length).fill(null);
      let gap = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) { gap++; continue; }
        const per = arr[i] / (gap + 1);
        for (let j = i - gap; j <= i; j++) out[j] = per;
        gap = 0;
      }
      if (out.some((x) => x != null)) precip.push(out);
    } else if (/^temperature_2m/.test(k)) {
      temp.push(arr);
    }
  }
  return { time: t.map((x) => x * 1000), precip, temp };
}

async function fetchEnsembles(lat, lon) {
  const out = [];
  for (const m of MODELS) {
    try {
      const d = await getJSON(`${OMENS}?latitude=${lat}&longitude=${lon}`
        + `&hourly=precipitation,temperature_2m&temperature_unit=fahrenheit&precipitation_unit=mm`
        + `&timezone=GMT&timeformat=unixtime&past_days=1&forecast_days=9&models=${m.id}`);
      const s = seriesFrom(d);
      if (s.precip.length) out.push({ model: m.label, ...s });
    } catch (e) {
      out.push({ model: m.label, error: String(e.message || e) });
    }
  }
  return out;
}

/** Score one game against the ensembles. Hour ending T covers (T-1h, T]. */
function score(ens, kickoffMs, now) {
  const end = kickoffMs + GAME_HOURS * 3600e3;
  let n = 0, any = 0, mod = 0, heavy = 0, totSum = 0;
  const temps = [];
  const models = [], errors = [];
  for (const e of ens) {
    if (e.error) { errors.push(e.model + ": " + e.error); continue; }
    const idx = [];
    e.time.forEach((T, i) => { if (T > kickoffMs && T - 3600e3 < end) idx.push(i); });
    if (idx.length < 3) { errors.push(e.model + ": game hours not covered"); continue; }
    let used = 0;
    for (const s of e.precip) {
      const vals = idx.map((i) => s[i]).filter((x) => x != null);
      if (vals.length < idx.length - 1) continue;
      const total = vals.reduce((a, b) => a + b, 0) * (idx.length / vals.length);
      const peak = Math.max(...vals);
      n++; used++; totSum += total;
      if (total >= MM.any) any++;
      if (peak >= MM.moderate) mod++;
      if (peak >= MM.heavy) heavy++;
    }
    for (const s of e.temp) for (const i of idx) if (s[i] != null) temps.push(s[i]);
    if (used) models.push(`${e.model} ${used}`);
    else errors.push(e.model + ": no usable members for the game hours");
  }
  if (!n) return { error: errors.join("; ") || "no ensemble data" };
  temps.sort((a, b) => a - b);
  const medT = temps.length ? temps[Math.floor(temps.length / 2)] : null;
  const pct = (k) => Math.round((100 * k) / n);
  return {
    members: n,
    models: models.join(" + "),
    anyRain: pct(any),
    moderate: pct(mod),
    heavy: pct(heavy),
    light: pct(any) - pct(mod) < 0 ? 0 : pct(any) - pct(mod),   // rain, but never above light
    meanTotalIn: round(totSum / n / 25.4, 2),
    tempF: round(medT),
    snowRisk: medT != null && medT <= SNOW_F,
    note: errors.length ? errors.join("; ") : undefined,
    leadHours: Math.max(0, Math.round((kickoffMs - +now) / 3600e3)),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const now = new Date();
  const games = await fetchSchedule(now);
  const byPlace = new Map();
  const out = [];
  for (const g of games) {
    const loc = await locate(g);
    const row = {
      id: g.id, kickoff: g.kickoff, state: g.state, detail: g.detail, tv: g.tv,
      away: g.away, home: g.home, neutral: g.neutral,
      venue: loc ? { name: loc.name, city: loc.city, roof: loc.roof, approx: loc.how === "geocoded" } :
                   { name: g.espnVenue.name, city: g.espnVenue.city, roof: "unknown" },
    };
    if (!loc) row.rain = { error: "stadium location unknown" };
    else if (loc.roof === "dome" || loc.roof === "covered") row.rain = null;
    else {
      const key = loc.lat.toFixed(3) + "," + loc.lon.toFixed(3);
      if (!byPlace.has(key)) byPlace.set(key, await fetchEnsembles(loc.lat, loc.lon));
      row.rain = score(byPlace.get(key), Date.parse(g.kickoff), now);
    }
    row.early = Date.parse(g.kickoff) - +now > WINDOW_DAYS * 86400e3;
    out.push(row);
  }
  const doc = {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    gameHours: GAME_HOURS,
    thresholds: { anyIn: 0.01, moderateInPerHr: 0.1, heavyInPerHr: 0.3 },
    source: "ESPN schedule · Open-Meteo GFS + ECMWF ensembles",
    games: out,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(doc, null, 1) + "\n");
  fs.renameSync(OUT + ".tmp", OUT);
  const wx = out.filter((r) => r.rain && !r.rain.error).length;
  console.log(`nfl: ${out.length} games, ${wx} with rain odds, ${byPlace.size} locations`);
}

module.exports = { main, windowEnd, seriesFrom, score, locate, fetchSchedule, HOME, NEUTRAL };
if (require.main === module) {
  main().catch((e) => { console.error("nfl: FAILED", e && e.stack || e); process.exit(1); });
}

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

   4. Wind       Same ensembles, same game hours. Per run: the strongest hourly
                 sustained wind and the strongest gust. Shown as the middle
                 run's value plus the share of runs at 15+ and 20+ mph.
   5. Surface    ESPN's game summary (grass: true/false); stadium table if
                 ESPN doesn't say.
   6. Rush D     nflverse weekly team stats (free CSV on GitHub). Each defense
                 is ranked 1-32 by EPA allowed per opponent carry, season to
                 date (1 = stingiest). Yards per carry shown alongside.

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
const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_";

const WINDOW_DAYS = 5;          // forecasts inside this are the reliable ones
const GAME_HOURS = 3.5;
const MODELS = [
  { id: "gfs025", label: "GFS" },
  { id: "ecmwf_ifs025", label: "ECMWF" },
];
const MM = { any: 0.25, moderate: 2.5, heavy: 7.6 };   // thresholds, millimetres
const SNOW_F = 34;                                      // at/below: may fall as snow
const WIND = { mild: 10, significant: 15, severe: 20 }; // mph, lower bounds
const NFLVERSE_ABBR = { LAR: "LA", WSH: "WAS" };        // ESPN -> nflverse team codes

// [name, city, lat, lon, roof, surface]. Roof: "open" | "retractable" (forecast
// shown, roof may close) | "dome" | "covered" (fixed roof, no rain on the field).
// Surface is only a fallback: ESPN's per-game flag wins. Keyed by ESPN abbreviation.
const HOME = {
  ARI: ["State Farm Stadium", "Glendale", 33.5276, -112.2626, "retractable", "grass"],
  ATL: ["Mercedes-Benz Stadium", "Atlanta", 33.7554, -84.4008, "retractable", "turf"],
  BAL: ["M&T Bank Stadium", "Baltimore", 39.2780, -76.6227, "open", "grass"],
  BUF: ["Highmark Stadium", "Orchard Park", 42.7738, -78.7870, "open", "grass"],
  CAR: ["Bank of America Stadium", "Charlotte", 35.2258, -80.8528, "open", "turf"],
  CHI: ["Soldier Field", "Chicago", 41.8623, -87.6167, "open", "grass"],
  CIN: ["Paycor Stadium", "Cincinnati", 39.0955, -84.5161, "open", "turf"],
  CLE: ["Huntington Bank Field", "Cleveland", 41.5061, -81.6995, "open", "grass"],
  DAL: ["AT&T Stadium", "Arlington", 32.7473, -97.0945, "retractable", "turf"],
  DEN: ["Empower Field at Mile High", "Denver", 39.7439, -105.0201, "open", "grass"],
  DET: ["Ford Field", "Detroit", 42.3400, -83.0456, "dome", "turf"],
  GB:  ["Lambeau Field", "Green Bay", 44.5013, -88.0622, "open", "grass"],
  HOU: ["NRG Stadium", "Houston", 29.6847, -95.4107, "retractable", "turf"],
  IND: ["Lucas Oil Stadium", "Indianapolis", 39.7601, -86.1639, "retractable", "turf"],
  JAX: ["EverBank Stadium", "Jacksonville", 30.3239, -81.6373, "open", "grass"],
  KC:  ["GEHA Field at Arrowhead Stadium", "Kansas City", 39.0489, -94.4839, "open", "grass"],
  LV:  ["Allegiant Stadium", "Las Vegas", 36.0909, -115.1833, "dome", "grass"],
  LAC: ["SoFi Stadium", "Inglewood", 33.9535, -118.3392, "covered", "turf"],
  LAR: ["SoFi Stadium", "Inglewood", 33.9535, -118.3392, "covered", "turf"],
  MIA: ["Hard Rock Stadium", "Miami Gardens", 25.9580, -80.2389, "open", "grass"],
  MIN: ["U.S. Bank Stadium", "Minneapolis", 44.9737, -93.2577, "dome", "turf"],
  NE:  ["Gillette Stadium", "Foxborough", 42.0909, -71.2643, "open", "turf"],
  NO:  ["Caesars Superdome", "New Orleans", 29.9511, -90.0812, "dome", "turf"],
  NYG: ["MetLife Stadium", "East Rutherford", 40.8135, -74.0745, "open", "turf"],
  NYJ: ["MetLife Stadium", "East Rutherford", 40.8135, -74.0745, "open", "turf"],
  PHI: ["Lincoln Financial Field", "Philadelphia", 39.9008, -75.1675, "open", "grass"],
  PIT: ["Acrisure Stadium", "Pittsburgh", 40.4468, -80.0158, "open", "grass"],
  SF:  ["Levi's Stadium", "Santa Clara", 37.4030, -121.9700, "open", "grass"],
  SEA: ["Lumen Field", "Seattle", 47.5952, -122.3316, "open", "turf"],
  TB:  ["Raymond James Stadium", "Tampa", 27.9759, -82.5033, "open", "grass"],
  TEN: ["Nissan Stadium", "Nashville", 36.1665, -86.7713, "open", "turf"],
  WSH: ["Northwest Stadium", "Landover", 38.9078, -76.8645, "open", "grass"],
};
HOME.WAS = HOME.WSH;

// Neutral / international venues, matched on the venue name ESPN reports.
const NEUTRAL = [
  [/tottenham/i, "London", 51.6043, -0.0664, "open", "grass"],
  [/wembley/i, "London", 51.5560, -0.2796, "open", "grass"],
  [/allianz arena/i, "Munich", 48.2188, 11.6247, "open", "grass"],
  [/deutsche bank park|waldstadion/i, "Frankfurt", 50.0686, 8.6455, "retractable", "grass"],
  [/olympiastadion/i, "Berlin", 52.5147, 13.2395, "open", "grass"],
  [/bernab[eé]u/i, "Madrid", 40.4531, -3.6883, "retractable", "grass"],
  [/stade de france/i, "Saint-Denis", 48.9245, 2.3602, "open", "grass"],
  [/maracan[aã]/i, "Rio de Janeiro", -22.9122, -43.2302, "open", "grass"],
  [/neo qu[ií]mica|corinthians/i, "São Paulo", -23.5453, -46.4742, "open", "grass"],
  [/melbourne cricket|\bmcg\b/i, "Melbourne", -37.8200, 144.9834, "open", "grass"],
  [/azteca|estadio banorte/i, "Mexico City", 19.3029, -99.1505, "open", "grass"],
  [/croke park/i, "Dublin", 53.3607, -6.2512, "open", "grass"],
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
  const place = (name, city, lat, lon, roof, how, surface) => ({
    name, city: city + (ev.state && how !== "neutral-table" ? ", " + ev.state : ev.country && ev.country !== "USA" ? ", " + ev.country : ""),
    lat, lon, roof, how, surface: surface || null,
  });
  const h = HOME[g.home.abbr];
  const cityMatch = h && ev.city && norm(ev.city).slice(0, 5) === norm(h[1]).slice(0, 5);
  const nameMatch = h && ev.name && norm(ev.name).includes(norm(h[0]).slice(0, 8));
  if (h && (cityMatch || nameMatch || (!ev.city && !g.neutral))) {
    return place(ev.name || h[0], h[1], h[2], h[3], h[4], "home-table", h[5]);
  }
  for (const [re, city, lat, lon, roof, surface] of NEUTRAL) {
    if (re.test(ev.name)) return place(ev.name, city, lat, lon, roof, "neutral-table", surface);
  }
  // Some other US stadium: if it's another team's home, use that entry.
  for (const [, v] of Object.entries(HOME)) {
    if (ev.name && norm(ev.name).includes(norm(v[0]).slice(0, 8))) return place(ev.name, v[1], v[2], v[3], v[4], "home-table", v[5]);
  }
  if (ev.city) {
    const r = await geocode(ev.city, ev.country);
    if (r) return place(ev.name || ev.city, ev.city, r.latitude, r.longitude, ev.indoor ? "dome" : "open", "geocoded");
  }
  if (h) return place(h[0], h[1], h[2], h[3], h[4], "home-table", h[5]);
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
  const precip = [], temp = [], wind = [], gust = [];
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
    } else if (/^wind_speed_10m/.test(k)) {
      wind.push(arr);
    } else if (/^wind_gusts_10m/.test(k)) {
      gust.push(arr);
    }
  }
  return { time: t.map((x) => x * 1000), precip, temp, wind, gust };
}

async function fetchEnsembles(lat, lon) {
  const out = [];
  for (const m of MODELS) {
    try {
      const d = await getJSON(`${OMENS}?latitude=${lat}&longitude=${lon}`
        + `&hourly=precipitation,temperature_2m,wind_speed_10m,wind_gusts_10m`
        + `&temperature_unit=fahrenheit&precipitation_unit=mm&wind_speed_unit=mph`
        + `&timezone=GMT&timeformat=unixtime&past_days=1&forecast_days=9&models=${m.id}`);
      const s = seriesFrom(d);
      if (s.precip.length) out.push({ model: m.label, ...s });
    } catch (e) {
      out.push({ model: m.label, error: String(e.message || e) });
    }
  }
  return out;
}

const windLevel = (mph) => mph == null ? null
  : mph >= WIND.severe ? "severe" : mph >= WIND.significant ? "significant" : mph >= WIND.mild ? "mild" : "negligible";

/** Middle run's strongest-hour value, its level, and the share of runs at
 *  significant (15+) and severe (20+) — for sustained wind and gusts. */
function windSummary(winds, gusts) {
  const one = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const mid = a[Math.floor(a.length / 2)];
    const pct = (th) => Math.round((100 * a.filter((x) => x >= th).length) / a.length);
    return { mph: Math.round(mid), level: windLevel(mid), sig: pct(WIND.significant), severe: pct(WIND.severe), runs: a.length };
  };
  const w = one(winds), g = one(gusts);
  return w || g ? { sustained: w, gust: g } : null;
}

/** Score one game against the ensembles. Hour ending T covers (T-1h, T]. */
function score(ens, kickoffMs, now) {
  const end = kickoffMs + GAME_HOURS * 3600e3;
  let n = 0, any = 0, mod = 0, heavy = 0, totSum = 0;
  const temps = [], winds = [], gusts = [];
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
    const peak = (s) => { const v = idx.map((i) => s[i]).filter((x) => x != null); return v.length >= idx.length - 1 ? Math.max(...v) : null; };
    for (const s of e.wind || []) { const v = peak(s); if (v != null) winds.push(v); }
    for (const s of e.gust || []) { const v = peak(s); if (v != null) gusts.push(v); }
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
    wind: windSummary(winds, gusts),
    note: errors.length ? errors.join("; ") : undefined,
    leadHours: Math.max(0, Math.round((kickoffMs - +now) / 3600e3)),
  };
}

// ---------------------------------------------------------------- surface
async function espnGrass(eventId) {
  try {
    const d = await getJSON(`${ESPN_SUMMARY}?event=${encodeURIComponent(eventId)}`);
    const g = ((d && d.gameInfo) || {}).venue || {};
    return typeof g.grass === "boolean" ? (g.grass ? "grass" : "turf") : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- rush defense
/** Minimal CSV reader (handles quoted fields). */
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = [];
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Season-to-date rush defense for every team from nflverse's weekly team
 *  stats: each row is one team's offense in one game, so a defense's numbers
 *  are the rows where it is the opponent. */
async function fetchRushDefense(now) {
  const t = new Date(now);
  const season = t.getUTCMonth() < 2 ? t.getUTCFullYear() - 1 : t.getUTCFullYear();   // Jan-Feb belong to last season
  const r = await fetch(`${NFLVERSE}${season}.csv`, { headers: { "User-Agent": "hightemp-nfl" }, redirect: "follow",
    signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined });
  if (r.status === 404) return { season, teams: {}, note: "no " + season + " games in nflverse yet" };
  if (!r.ok) throw new Error("nflverse HTTP " + r.status);
  const rows = parseCSV(await r.text());
  const agg = {};
  let lastWeek = 0;
  for (const x of rows) {
    const d = x.opponent_team, car = +x.carries;
    if (!d || !isFinite(car) || car <= 0) continue;
    const a = (agg[d] = agg[d] || { carries: 0, yards: 0, epa: 0, games: 0 });
    a.carries += car; a.yards += +x.rushing_yards || 0; a.epa += +x.rushing_epa || 0; a.games++;
    lastWeek = Math.max(lastWeek, +x.week || 0);
  }
  const list = Object.entries(agg).map(([team, a]) => ({
    team, games: a.games,
    epaPerCarry: a.epa / a.carries,
    ypc: round(a.yards / a.carries, 1),
    ypg: round(a.yards / a.games, 0),
  })).sort((x, y) => x.epaPerCarry - y.epaPerCarry);
  const teams = {};
  list.forEach((x, i) => { teams[x.team] = { rank: i + 1, of: list.length, epaPerCarry: round(x.epaPerCarry, 3), ypc: x.ypc, ypg: x.ypg, games: x.games }; });
  return { season, throughWeek: lastWeek, teams };
}

// ---------------------------------------------------------------- main
async function main() {
  const now = new Date();
  const games = await fetchSchedule(now);
  let rushD = null;
  try { rushD = await fetchRushDefense(now); } catch (e) { rushD = { error: String(e.message || e), teams: {} }; }
  const rd = (abbr) => (rushD.teams || {})[NFLVERSE_ABBR[abbr] || abbr] || null;
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
    row.venue.surface = (await espnGrass(g.id)) || (loc && loc.surface) || null;
    row.away.rushD = rd(g.away.abbr);
    row.home.rushD = rd(g.home.abbr);
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
    rushDefense: { season: rushD.season, throughWeek: rushD.throughWeek, metric: "EPA allowed per opponent carry", note: rushD.note, error: rushD.error },
    windLevels: { mild: WIND.mild, significant: WIND.significant, severe: WIND.severe },
    games: out,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(doc, null, 1) + "\n");
  fs.renameSync(OUT + ".tmp", OUT);
  const wx = out.filter((r) => r.rain && !r.rain.error).length;
  console.log(`nfl: ${out.length} games, ${wx} with rain odds, ${byPlace.size} locations`);
}

module.exports = { main, windowEnd, parseCSV, fetchRushDefense, windSummary, windLevel, seriesFrom, score, locate, fetchSchedule, HOME, NEUTRAL };
if (require.main === module) {
  main().catch((e) => { console.error("nfl: FAILED", e && e.stack || e); process.exit(1); });
}

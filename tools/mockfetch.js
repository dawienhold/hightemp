/* Offline test harness: fakes every upstream feed with plausible data so the
   runner's plumbing (state, scoring, files, failure handling) can be exercised
   without network. Load with:  node -r ./tools/mockfetch.js scripts/run.js
   MOCK_FAIL=KMDW makes that station's feeds fail. MOCK_NOW overrides the clock. */
"use strict";
if (process.env.MOCK_NOW) {
  const RealDate = Date, fixed = new RealDate(process.env.MOCK_NOW).getTime(), start = RealDate.now();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed + (RealDate.now() - start)); }
    static now() { return fixed + (RealDate.now() - start); }
  };
}
const MODELS = ["gfs_hrrr","gfs_seamless","ecmwf_ifs025","ecmwf_aifs025_single","icon_seamless","gem_seamless",
                "ukmo_seamless","jma_seamless","meteofrance_seamless","gfs_graphcast025"];
const BASE = { KNYC: 70, KMIA: 88, KMDW: 66, KLAX: 77, KSFO: 67, KLGA: 70, KEWR: 71, KJRB: 70, KTEB: 70 };
const CLI_LOC = { NYC: "KNYC", MIA: "KMIA", MDW: "KMDW", LAX: "KLAX", SFO: "KSFO" };
const STD = { KNYC: -5, KMIA: -5, KMDW: -6, KLAX: -8, KSFO: -8 };
const fail = new Set((process.env.MOCK_FAIL || "").split(",").filter(Boolean));
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const cToF = c => c * 9 / 5 + 32, fToC = f => (f - 32) * 5 / 9;
const diurnal = (base, h) => base - 8 + 8 * Math.max(0, Math.sin(Math.PI * (h - 6) / 12)); // local hour
const json = v => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
const text = v => ({ ok: true, status: 200, json: async () => JSON.parse(v), text: async () => v });
const q = (u, k) => new URL(u).searchParams.get(k);
const latKey = u => { const lat = +q(u, "latitude"); return lat > 40.7 && lat < 40.8 ? "KNYC" : lat < 26 ? "KMIA" : lat > 41.7 && lat < 41.8 ? "KMDW" : lat < 34 ? "KLAX" : "KSFO"; };

function localHours(tz, days0, days1) {
  // time strings in local wall time, hourly, from today-days0 to today+days1
  const out = [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  for (let d = -days0; d < days1; d++) for (let h = 0; h < 24; h++) out.push(`${addDays(today, d)}T${String(h).padStart(2, "0")}:00`);
  return out;
}
function metarRows(id, hours) {
  const rows = [], now = Date.now(), std = STD[id] ?? -5;
  for (let t = Math.floor((now - hours * 3600e3) / 3600e3) * 3600e3 + 53 * 60e3; t <= now; t += 3600e3) {
    const d = new Date(t), lh = ((d.getUTCHours() + std + 1 + 24) % 24) + d.getUTCMinutes() / 60;
    const c = Math.round(fToC(diurnal(BASE[id], lh)) * 10) / 10;
    const s = v => (v < 0 ? "1" : "0") + String(Math.round(Math.abs(v) * 10)).padStart(3, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0"), hh = String(d.getUTCHours()).padStart(2, "0");
    let rmk = `RMK AO2 T${s(c)}${s(c - 3)}`;
    if ([23, 5, 11, 17].includes(d.getUTCHours())) rmk += ` 1${s(c + 0.4).slice(0)}`.replace(" 10", " 10").replace(/ 1(\d)/, " 1$1");
    rows.push({ obsTime: Math.floor(t / 1000), temp: Math.round(c), rawOb: `METAR ${id} ${dd}${hh}53Z 27008KT 10SM FEW250 ${Math.round(c)}/${Math.round(c - 3)} A3000 ${rmk}` });
  }
  return rows;
}

global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("ntfy.sh")) {
    console.log("[mock push]", init && init.headers && init.headers.Title, "|", init && init.body);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }
  const id = u.match(/stations\/(K\w{3})/)?.[1] || q(u, "ids")?.split(",")[0];
  if (fail.size) {
    for (const f of fail) {
      if (u.includes(f) || (u.includes("latitude") && latKey(u) === f) || u.includes("locations/" + f.slice(1))) throw new Error("mock failure " + f);
    }
  }
  if (u.includes("aviationweather.gov")) {
    const ids = q(u, "ids").split(","), hours = +q(u, "hours") || 3;
    if (q(u, "format") === "raw") return text(ids.flatMap(i => metarRows(i, hours).map(r => r.rawOb)).join("\n"));
    return json(ids.flatMap(i => metarRows(i, hours)));
  }
  if (u.includes("/products/types/CLI/locations/")) {
    const loc = u.split("/").pop(), sid = CLI_LOC[loc], g = [];
    for (let k = 1; k <= 20; k++) {
      const day = addDays(ymd(new Date()), -k);
      g.push({ id: `${loc}-${day}-final`, issuanceTime: addDays(day, 1) + "T08:30:00Z" });
      g.push({ id: `${loc}-${day}-prelim`, issuanceTime: day + "T21:30:00Z" });
    }
    g.unshift({ id: `${loc}-${ymd(new Date())}-prelim`, issuanceTime: ymd(new Date()) + "T21:30:00Z" });
    return json({ "@graph": g });
  }
  if (u.includes("/products/")) {
    const pid = u.split("/").pop(), [loc, y, m, d, kind] = pid.split(/-/);
    const sid = CLI_LOC[loc];
    const mon = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"][+m - 1];
    const max = BASE[sid] + ((+d * 7) % 5) - 2 - (kind === "prelim" ? 6 : 0);
    return json({ productText: `CLIMATE SUMMARY FOR ${mon} ${+d} ${y}\nTEMPERATURE (F)\n YESTERDAY\n  MAXIMUM         ${max}    314 PM\n  MINIMUM         ${max - 12}    545 AM\n` });
  }
  if (u.includes("/observations")) {
    const rows = metarRows(id, 30);
    return json({ features: rows.map(r => ({ properties: { timestamp: new Date(r.obsTime * 1000).toISOString(),
      temperature: { value: Math.round(r.temp) }, rawMessage: "" } })) });
  }
  if (u.includes("/gridpoints/")) {
    const out = [];
    for (let k = 0; k < 3; k++) out.push({ validTime: addDays(ymd(new Date()), k) + "T12:00:00+00:00/PT12H", value: fToC(70 + k) });
    return json({ properties: { maxTemperature: { uom: "wmoUnit:degC", values: out } } });
  }
  if (u.includes("open-meteo.com")) {
    const sid = latKey(u), tz = q(u, "timezone"), past = +(q(u, "past_days") || 0), fut = +(q(u, "forecast_days") || 3);
    if (u.includes("ensemble-api")) {
      const time = localHours(tz, 0, fut), hourly = { time };
      for (let m = 1; m <= 5; m++) hourly["temperature_2m_member0" + m] = time.map(t => diurnal(BASE[sid], +t.slice(11, 13)) + m - 3);
      return json({ hourly });
    }
    if (u.includes("previous-runs")) {
      const time = localHours(tz, past, fut), hourly = { time };
      for (const m of MODELS) hourly["temperature_2m_previous_day1_" + m] = time.map(t => diurnal(BASE[sid], +t.slice(11, 13)) + (m.length % 3) - 1);
      return json({ hourly });
    }
    if (q(u, "daily") && q(u, "daily").includes("temperature_2m_max")) {
      const time = []; const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
      for (let d = -past; d < fut; d++) time.push(addDays(today, d));
      const daily = { time };
      for (const m of MODELS) daily["temperature_2m_max_" + m] = time.map(dd => BASE[sid] + ((+dd.slice(8)) * 7 % 5) - 2 + (m.length % 3) - 1);
      return json({ daily });
    }
    if (q(u, "daily") && q(u, "daily").includes("sunrise")) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
      const days = [0, 1, 2].map(k => addDays(today, k));
      return json({ daily: { time: days, sunrise: days.map(d => d + "T06:45"), sunset: days.map(d => d + "T19:00") } });
    }
    const hv = q(u, "hourly") || "";
    const time = localHours(tz, past, fut), hourly = { time };
    if (hv.startsWith("temperature_2m")) {
      for (const m of MODELS) hourly["temperature_2m_" + m] = time.map(t => diurnal(BASE[sid], +t.slice(11, 13)) + (m.length % 3) - 1);
    } else {
      for (const k of hv.split(",")) hourly[k] = time.map((t, i) => ({ cloud_cover: 40, shortwave_radiation: 450, wind_speed_10m: 8,
        wind_direction_10m: 250, dew_point_2m: 58, precipitation: 0, relative_humidity_2m: 65, boundary_layer_height: 900 }[k] ?? 0));
    }
    return json({ hourly });
  }
  throw new Error("mock: unhandled " + u);
};

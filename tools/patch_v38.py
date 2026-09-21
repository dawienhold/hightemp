import io, sys
src, dst = sys.argv[1], sys.argv[2]
s = io.open(src, encoding="utf-8").read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f"expected {count} of:\n{old}\nfound {n}")
    s = s.replace(old, new)

rep('const MODEL_VERSION = "3.7";', 'const MODEL_VERSION = "3.8";')

# --- climate day: midnight-to-midnight LOCAL STANDARD TIME, as the CLI defines it
rep('''function addDays(ymd, n) {''', '''/**
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

function addDays(ymd, n) {''')

# --- fetch: identify ourselves (api.weather.gov requires it outside a browser), time out, retry
rep('''  const r = await fetch(url, { headers: { Accept: "application/geo+json,application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const v = await r.json();''', '''  const headers = { Accept: "application/geo+json,application/json" };
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
  if (lastErr) throw lastErr;''')

# --- CLI: only a FINAL report settles. The afternoon "valid today as of 4 PM" issue
#     carries the same date and a partial maximum; it must never score a call.
rep('''  for (const p of graph.slice(0, 32)) {''', '''  for (const p of graph.slice(0, 64)) {''')
rep('''    if (rec && !rec.bad) out.push({ ...rec, issued: p.issuanceTime });
  }
  const seen = new Set(), ded = [];
  out.sort((a, b) => b.date.localeCompare(a.date));''', '''    if (rec && !rec.bad) {
      // Final once issued after the climate day closed (midnight standard time).
      const off = STD_OFFSET_H[st.tz] ?? 0;
      const closeUTC = new Date(addDays(rec.date, 1) + "T00:00:00Z").getTime() - off * 3600e3;
      const final = !!p.issuanceTime && new Date(p.issuanceTime).getTime() >= closeUTC;
      if (final) out.push({ ...rec, issued: p.issuanceTime, final: true, productId: p.id });
    }
  }
  const seen = new Set(), ded = [];
  // newest date first; within a date the latest issuance wins (corrections)
  out.sort((a, b) => b.date.localeCompare(a.date) || String(b.issued).localeCompare(String(a.issued)));''')

# --- observations: file every reading under its climate day
rep('''async function fetchDayObs(st, nowD) {
  const today = localDate(nowD, st.tz);''', '''async function fetchDayObs(st, nowD) {
  const today = climDate(nowD, st.tz);''')
rep('''  const keep = prim.filter(r => localDate(r.t, st.tz) === today);''',
    '''  const keep = prim.filter(r => climDate(r.t, st.tz) === today);''')
rep('''        if (localDate(r.t, st.tz) !== today) continue;''',
    '''        if (climDate(r.t, st.tz) !== today) continue;''')
rep('''  const startOk = localDate(new Date(syn.getTime() - 6 * 3600e3 + 60e3), tz) === day;
  const endOk   = localDate(new Date(syn.getTime() - 60e3), tz) === day;''',
    '''  const startOk = climDate(new Date(syn.getTime() - 6 * 3600e3 + 60e3), tz) === day;
  const endOk   = climDate(new Date(syn.getTime() - 60e3), tz) === day;''')
rep('''async function runStation(st, cliCache, memory) {
  const nowD = new Date();
  const today = localDate(nowD, st.tz);''', '''async function runStation(st, cliCache, memory) {
  const nowD = new Date();
  const today = climDate(nowD, st.tz);''')

# --- never log a call made in the hour after local midnight while DST is on:
#     the climate day it belongs to has already closed on the wall clock.
rep('''  return snap.stations.filter(s => !s.error && s.today).map(s => {''',
    '''  return snap.stations.filter(s => {
    if (s.error || !s.today) return false;
    const meta = STATIONS.find(x => x.id === s.station);
    return !meta || localDate(new Date(at), meta.tz) === s.today.date;
  }).map(s => {''')

# --- a CLI cache that survives between runs
rep('''async function runAll(onProgress, regime) {
  const cliCache = new Map();''', '''async function runAll(onProgress, regime, cache) {
  const cliCache = cache || new Map();''')
rep('''  const res = await runAll(opts.onProgress, opts.regime);''',
    '''  const res = await runAll(opts.onProgress, opts.regime, opts.cliCache);''')

rep('''         sixHourWindowInDay, localHM, localDate, localHour, localClock, addDays, median, mad, normCdf };''',
    '''         sixHourWindowInDay, localHM, localDate, climDate, localHour, localClock, addDays, median, mad, normCdf };''')
rep('''window.HT = HT;''', '''if (typeof window !== "undefined") window.HT = HT;''')

io.open(dst, "w", encoding="utf-8").write(s)
print("ok", len(s))

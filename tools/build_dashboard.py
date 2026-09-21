import io, re, sys
src, dst = sys.argv[1], sys.argv[2]
s = io.open(src, encoding="utf-8").read()
def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count: raise SystemExit(f"expected {count}, found {n}:\n{old[:200]}")
    s = s.replace(old, new)

# 1. proper standalone document
head_end = s.index('<div class="wrap">')
head = s[:head_end]
body = s[head_end:]
head = head.replace('<title>High-Temp Desk</title>', '')
s = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
     '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
     '<title>High-Temp Desk</title>\n' + head + '\n</head>\n<body>\n' + body)
s = s.replace('</script>\n\n</body></html>', '</script>\n</body>\n</html>')
if not s.rstrip().endswith('</html>'): s = s.rstrip() + '\n</body>\n</html>\n'

# 2. copy
rep('''<p class="muted small" style="margin-top:12px">This page shows the most recent forecast pass. It is a mirror: the numbers are written here by the 7:00 AM Eastern run and the scheduled intraday runs, so it is always a stored reading rather than a live one. The desk file on your laptop refreshes every three minutes from the stations directly.</p>''',
    '''<p class="muted small" style="margin-top:12px">This page shows the most recent forecast pass. A scheduled job runs every 20 minutes, fetches the stations and the models, scores whatever has settled, and commits the result to this site. The time stamp at the top says how old the numbers are.</p>''')
rep('''<p>Sources: <code>api.weather.gov</code> and <code>open-meteo.com</code>. Both free, no key.</p>''',
    '''<p><strong>Which day a reading belongs to.</strong> The CLI's climate day runs midnight to midnight <em>local standard time</em>. While daylight time is in force that is 1:00 AM to 1:00 AM on the wall clock, so a reading at 12:30 AM belongs to the previous day's report. Every observed maximum on this page is filed that way. Only a <em>final</em> CLI (issued after the day closes) settles a call; the afternoon preliminary report never does.</p>
      <p>Sources: <code>api.weather.gov</code>, <code>aviationweather.gov</code> and <code>open-meteo.com</code>. Raw METARs, every call and every settlement are archived in the repository's <code>docs/data</code> folder.</p>''')

# 3. chart: a reading after local midnight in the DST hour belongs to the end of the day
rep('''  const obs = (s.curve || []).map(([hm, v]) => ({ x: hm2h(hm), y: v, kind: "obs" }));
  const inf = (s.inferredCurve || []).map(([hm, v]) => ({ x: hm2h(hm), y: v, kind: "inf" }));''',
    '''  const unwrap = arr => { let prev = -1; return arr.map(p => { if (prev >= 0 && p.x < prev - 12) p.x += 24; prev = p.x; return p; }); };
  const obs = unwrap((s.curve || []).map(([hm, v]) => ({ x: hm2h(hm), y: v, kind: "obs" })));
  const inf = unwrap((s.inferredCurve || []).map(([hm, v]) => ({ x: hm2h(hm), y: v, kind: "inf" })));''')
rep('''  const xs = [Math.min(4, Math.floor(Math.min(...all.map(p => p.x)))), 23];''',
    '''  const xs = [Math.min(4, Math.floor(Math.min(...all.map(p => p.x)))), Math.max(23, Math.ceil(Math.max(...all.map(p => p.x))))];''')
rep('''    tx.textContent = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "a" : "p"); g.appendChild(tx);''',
    '''    const hh = h % 24; tx.textContent = (hh % 12 === 0 ? 12 : hh % 12) + (hh < 12 ? "a" : "p"); g.appendChild(tx);''')

# 4. a station whose feeds failed keeps its last good card, flagged
rep('''  card.appendChild(head);

  // headline''', '''  card.appendChild(head);
  if (s.stale) {
    card.appendChild(el("p", "caveat",
      "Feeds for this station failed on the latest pass (" + (s.staleError || "error") + "). Showing the last good pass, from " +
      new Date(s.staleSince || Date.now()).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + "."));
  }

  // headline''')

# 5. loader: read the committed files instead of the artifact database
start = s.index('(async () => {\n  const db = await claude.use("db");')
end = s.index('})();\n})();', start)
loader = r'''async function getJSON(p) {
  const r = await fetch(p + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(p + " HTTP " + r.status);
  return r.json();
}
async function load() {
  let snap = null;
  try { snap = await getJSON("data/latest.json"); }
  catch (e) { $("emptyText").textContent = "Could not read the latest pass: " + String(e.message || e); }
  if (snap && snap.stations) render(snap);
  let st = null;
  try { st = await getJSON("data/status.json"); } catch (e) { /* first deploy: no status yet */ }
  const note = $("staleNote");
  if (st && st.lastOk === false) {
    note.hidden = false;
    note.textContent = `The most recent run failed (${st.consecutiveFailures || 1} in a row): ${st.lastError}. ` +
      (st.lastOkAt ? `Numbers below are from the last successful pass, ${ago(st.lastOkAt)}.` : "");
    $("statusDot").className = "dot bad";
  } else if (snap && snap.meta && snap.meta.missedMorning && !note.hidden === false) {
    note.hidden = false;
    note.textContent = `No 7 AM call was made on ${snap.meta.missedMorning} — the first run of the day came after 10 AM Eastern, so the morning table shows the last one made.`;
  }
}
(async () => {
  await load();
  setInterval(load, 2 * 60000);
  setInterval(() => {
    const t = $("ranAt").dataset.iso;
    if (t) $("statusText").textContent = "last pass " + ago(t);
  }, 60000);
'''
s = s[:start] + loader + s[end:]
io.open(dst, "w", encoding="utf-8").write(s)
print("ok", len(s))

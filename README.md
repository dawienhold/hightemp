# hightemp

Daily-high forecasts for **KNYC, KMIA, KMDW, KLAX, KSFO**, scored against the
NWS Daily Climate Report (CLI) — the number the markets settle on.

Dashboard: **https://dawienhold.github.io/hightemp/**

## How it runs

A GitHub Actions job (`.github/workflows/pass.yml`) runs every 20 minutes. Each
run fetches observations, CLI reports and model guidance, makes the forecast,
scores anything that has settled, and commits the results to `docs/data/`.
GitHub Pages serves `docs/` as the dashboard. No laptop, browser or AI is
involved in producing the numbers.

The first run at or after **7:00 AM Eastern** (and before 10:00) is the
morning call. That run also grades the previous morning's calls.

## Where the data is

| File | What it holds |
|---|---|
| `docs/data/latest.json` | the latest pass (what the dashboard draws) |
| `docs/data/status.json` | heartbeat: last run, last success, last error |
| `docs/data/runs.jsonl` | one line per run, success or failure |
| `docs/data/history/YYYY-MM.jsonl` | every call every run made |
| `docs/data/cli.json` | every final CLI maximum seen, per station and date |
| `docs/data/raw/metar/YYYY-MM-DD.txt` | raw METAR/SPECI text as received |
| `docs/data/stats.json` | scorecard accumulators |
| `docs/data/state.json` | settlement queue, regime memory, CLI cache |

## Rules the engine follows (v3.8)

* **Climate day = midnight to midnight local standard time.** During daylight
  time that is 1 AM to 1 AM on the wall clock; a 12:30 AM reading belongs to the
  previous day. Observed maxima are filed accordingly.
* **Only a final CLI settles a call** (one issued after the climate day closed).
  The afternoon preliminary report is ignored for scoring.
* A whole-degree Celsius reading is a range, not a measurement; only the hourly
  tenths group or the 6-hour maximum group pins a maximum.

## If something goes wrong

* A failed run turns the workflow red and GitHub emails you. The dashboard shows
  a red banner with the error and keeps the last good numbers.
* If one station's feeds fail, its card shows the last good pass, marked stale.
* To run a pass by hand: **Actions → forecast-pass → Run workflow**. Tick
  "Force this run to be the 7am call" only if the morning call was missed.

## Testing without network

`node tools/selftest.js` runs four passes against fake feeds (normal, morning,
one station down, all down) in a temporary copy.

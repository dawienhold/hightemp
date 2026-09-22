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
| `docs/data/madis_omo.json` | optional rolling NOAA MADIS One-Minute ASOS cache |
| `docs/data/stats.json` | scorecard accumulators |
| `docs/data/state.json` | settlement queue, regime memory, CLI cache |

## Rules the engine follows (v4.0)

* **Climate day = midnight to midnight local standard time.** During daylight
  time that is 1 AM to 1 AM on the wall clock; a 12:30 AM reading belongs to the
  previous day. Observed maxima are filed accordingly.
* **Only a final CLI settles a call** (one issued after the climate day closed).
  The afternoon preliminary report is ignored for scoring.
* **Same-day preliminary CLI is a floor.** The afternoon report ("valid today
  as of 4 PM") still never scores a call, but its maximum is the station's own
  ASOS maximum so far, so today's distribution cannot go below it.

* **Free MADIS One-Minute ASOS is optional extra evidence.** A pre-pass helper can read NOAA's public HFMETAR/OMO files into `docs/data/madis_omo.json`; the engine merges those observations when present and falls back cleanly when they are absent or stale. OMO temperatures remain quantized evidence, not settlement truth.
* **Whole-degree-C peaks now affect the degree probabilities.** If a high-frequency 22C observation is compatible with either 71F or 72F while a precise hourly T-group has only pinned 71.xF, the engine carries the quantization range into the 71-vs-72 probability instead of letting the lower precise report suppress it. Hidden-peak and quantization evidence are not added together; the stronger signal is used to avoid double counting.
* **Central Park's hidden peaks.** KNYC reports hourly, and the official high
  often falls between readings: over 2022-2026 the hourly readings alone came
  in below the CLI on 57% of days (5.5% once the 6-hour maximum groups are
  included). Until the next 6-hour group covers the afternoon, the card shows a
  calibrated chance that the high is already a degree above anything reported
  (37-58% when the latest high reading is the peak, 16% when later readings
  came within a degree, 7% otherwise). Table and method: `HIDDEN_PEAK` in
  `engine/engine.js`. `tools/replay_knyc.js` replays 2026-09-21 as a check.
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

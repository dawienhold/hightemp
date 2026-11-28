# hightemp

Daily-high forecasts for **KNYC, KPHL, KMIA, KMDW, KLAX, KSFO**, scored against the
NWS Daily Climate Report (CLI) — the number the markets settle on.

Dashboard: **https://dawienhold.github.io/hightemp/**

## Crypto Lab · BTC and ETH paper research

**https://dawienhold.github.io/hightemp/crypto.html** adds a separate BTC research
desk to the shared navigation. Four streams cover **BTC 5m, BTC 15m, ETH 5m,
and ETH 15m**, with separate model fits, price archives and performance counts.
It uses public **Polymarket US** market discovery, typed contract terms, full order
books, market-specific fee coefficients, and reference-price history. Bitcoin uses
**BRTI**; Ethereum uses **ETHUSD_RTI**. No API key, wallet or exchange account is accessed.
The collector only permits GET requests to explicitly listed research endpoints;
there is no live-order implementation or browser-side secret entry.

The independent `crypto-research` workflow collects every five minutes, offset
about a minute into each window. GitHub may delay or skip starts. Collection gaps,
source times, receipt times, quotes, and unavailable inputs are recorded. This is
a scheduled research collector, not a continuous trading service. It does not
alter weather forecasting, weather data collection, or existing trading research.
Completion of forecast-pass, market-openings, shadow-observer or
contract-consistency additionally checks freshness and collects when the latest
four-stream snapshot is at least four minutes old, incomplete, or failed.
Healthy, recent snapshots skip duplicate recovery work. This provides a second
GitHub trigger path, not an independent scheduler or a guaranteed interval.

The provisional model fits a regularized HAR-style log-variance regression to
each asset's own one-minute reference-index close returns over the last 60 hours. Squared minute returns are
a variance proxy, not tick-level realized variance. Log-variance predictions use
a smearing adjustment. The model assumes zero drift, fixed Student-t tails
(five degrees of freedom), and constant forecast variance over the remaining
window. It approximates the contract's closing-minute arithmetic average using
discrete Brownian covariance weights, incorporates already observed closing
samples, and abstains if any required elapsed second is missing. Partial candles
and empty, carried-forward buckets are excluded. Training data are not counted
as historical simulated trades or evidence of profitability.

Paper entries require fresh reference data and books, verified rules, a known
fee coefficient, and at least **2 cents estimated net edge per contract**. The
paper research threshold was lowered from 5 cents in v0.3 to collect more entries.
Quote requests use unique timestamped URLs to avoid cached public quote responses;
the 15-second source freshness gate is still enforced. A second
book is fetched after at least 2.5 seconds before a fill can be simulated. The
simulation uses available depth, a maximum of 10 contracts, fees rounded upward
to cents, and a 1-cent adverse-price reserve per contract. One entry per market
is permitted, with a $30 aggregate open-cost cap in a $1,000 simulated account.
That account and cap are shared across all four streams, not duplicated per asset.
There is no scheduled first trade or requirement to wait for several collection
days: the next qualifying fresh signal can generate a paper entry. Forecasts are
captured and scored independently of whether an entry qualifies. Missing edge,
stale feeds, inadequate depth and later-quote failures remain abstentions.
These settings are research assumptions in `scripts/crypto/config.json`.
No maker queue fills are assumed. Paper exposure is carried at cost, not marked
to market. Drawdown is calculated from realized settlement P&L only.

Official resolved status and a confirmed binary settlement endpoint response
are both required to grade a window or trade. Pending settlement remains pending.
One first eligible, prospectively captured forecast per market is scored,
including markets without a paper trade. Brier scores compare the HAR-style
forecast with a 60-minute constant-volatility baseline. Overlapping five- and
15-minute windows are correlated; neither sample counts nor model estimates
establish an independent trading edge. All model probabilities are provisional.

### Additional diagnostics in v0.3

Each asset now has a separate exponentially weighted moving-average (EWMA)
variance estimate alongside HAR and the 60-minute baseline. Its recurrence is
`v_next = lambda * v_previous + (1 - lambda) * return_squared`, with
`lambda = exp(-ln(2) / halfLifeMinutes)`. The research settings use a 10-minute
half-life and up to 180 contiguous, complete minute returns. Missing minutes
make the diagnostic unavailable; an absent EWMA does not substitute another
asset's data or change the HAR entry forecast. Probability spread and the ratio
of EWMA to HAR volatility are archived as diagnostics, not confidence intervals.

EWMA probabilities are stored only on first forecasts captured after this
upgrade. The new comparison computes Brier score and clipped log loss for HAR,
EWMA and the baseline on the exact same settled-window cohort. Historical
forecasts without EWMA remain missing; they are not reconstructed. Log-loss
probabilities are clipped at 1e-12 and 1-1e-12 for numerical stability. Existing
overall HAR/baseline scores retain their original cohort.

New paper entries retain the active minimum edge and policy version, signal
probability, all-in break-even probability, expected profit, expected return on
cost, and the three forecasts at the signal time. Expected values are model
estimates; they are not realized P&L. CSV export includes these fields.
The entry-edge summary groups recorded entries into below 2c, 2-3c, 3-5c, 5c or
more, and missing-edge records. Bands have inclusive lower and exclusive upper
bounds. Open trades are excluded from realized win rates and returns; returns
use total realized P&L divided by total settled entry cost. These are descriptive
summaries of actual paper entries, not counterfactual threshold backtests.

| Crypto file | Contents |
|---|---|
| `docs/data/crypto/latest.json` | Per-asset models, prices and charts; four-stream quotes, ledger and scorecards |
| `docs/data/crypto/status.json` | Health, last successful collection, errors |
| `docs/data/crypto/state.json` | Forecasts awaiting official outcomes and the complete paper state |
| `docs/data/crypto/ledger.json` | Complete simulated-trade ledger for CSV export |
| `docs/data/crypto/history/YYYY-MM-DD.jsonl.gz` | Timestamped quote depth, model, settings, decisions and settlement events |
| `docs/data/crypto/prices/btc/YYYY-MM-DD-1S.jsonl.gz` | New BTC seconds; ETH uses the separate `prices/eth` folder |
| `docs/data/crypto/prices/btc/YYYY-MM-DD-1M.jsonl.gz` | New BTC minute training prices; ETH has independent minute archives |

The v0.1 BTC-only state migrates without resetting forecasts or trades. Its old
price files remain in `prices/`; their watermarks become BTC-only watermarks.
ETH begins with its own empty watermarks and independent fit. Unavailable ETH
data never fall back to BTC observations. The shared paper ledger records an
asset field on new entries and retains its original capital and exposure limits.

The gzip files contain concatenated gzip members, one per appended JSON line;
standard gzip readers and Node's `gunzipSync` decode all members. Repeated source
price timestamps are not appended again. Each collector run is locked and JSON
files are atomically replaced. The workflow stages only `docs/data/crypto` and
rebases unrelated data commits; it never force pushes or discards a real conflict.

Run locally with `npm run crypto`; verify with `npm run test:crypto` and
`node tools/sync-nav.js --check`. On GitHub, use **Actions → crypto-research →
Run workflow**. The workflow also starts after relevant source changes. Core
collection and statistics use Node 22 and require no third-party dependencies.

Daily lows for **KNYC (Central Park)** and **KMDW (Midway)**:
**https://dawienhold.github.io/hightemp/lows.html**. Today and tomorrow cover
the full NWS local-standard-time climate day, including evening cooling and
the following midnight hour during DST. Low guidance, biases and scores are
separate from the highs; no high hidden-peak calibration is reused for lows.
The low model is provisional, retains a conservative uncertainty allowance,
and shrinks minimum-only calibration toward zero (8 distinct dates required,
20 prior days, maximum 1.5°F adjustment). Low calls are archived in
`docs/data/low/history`; only final CLI minimums grade them.

### October 15 performance review

The existing high model has 17 settled climate dates: all-call MAE 1.11°F,
warm bias +0.48°F. Calls from the same day are correlated. New diagnostics
therefore select one call per station/date within each 07, 10, 14 and 18 local
hour. Current 07-hour MAEs are 0.93°F NYC, 0.79°F Miami, 1.33°F Midway,
1.80°F LAX and 2.69°F SFO, based on only 14–16 dates per station. These are
descriptive results, not evidence of profitable trading or a validated bias
correction. No fitted station-hour offsets or tighter high probability bands
are introduced from this short sample. Review requires at least 20 distinct
settled dates and further out-of-sample evidence.

Probability scores now retain the full integer distribution and penalize a
missing realized outcome. Old cumulative checkpoint scores retain their
original calculations; `performance.json` independently reconstructs scores
from archived full distributions where present. The high forecast version
remains 4.2.2 because its numeric forecast logic is unchanged; lows use their
own `low-1.0.0` version. Philadelphia also joins observation collection and
the high-temperature market-opening tracker without borrowing another
station's calibration history.

## How it runs

A GitHub Actions job (`.github/workflows/pass.yml`) runs every 20 minutes. Each
run fetches observations, CLI reports and model guidance, makes the forecast,
scores anything that has settled, and commits the results to `docs/data/`.
If GitHub delays the forecast schedule, completion of any of the five existing
collectors (market-openings, shadow-observer, NFL, MLB, or consistency) checks
for a snapshot at least 18 minutes old and refreshes it. Automatic starts skip
healthy recent snapshots, but retry missing or failed station cards. Forecast
jobs share one concurrency group and check the current `main` branch. Code
changes and explicit requests always run. Optional MADIS installation/downloads
have deadlines and cannot prevent the main forecast from running.

Publication stages only forecast-owned data. Unrelated collector commits are
rebased normally. A forecast data conflict is aborted, then a new pass is
computed from current upstream state and history, with at most three attempts;
no force push or manual mixing of forecast JSON/state is used. This also handles
an older queued pass encountering newer published data.

GitHub schedules can delay or drop starts. Recovery triggers on GitHub alone
cannot guarantee an update interval; an independent hourly ChatGPT recovery
check is configured separately to restart an overdue updater through the
authenticated GitHub connector. It does not change the normal 20-minute
schedule or the forecast probability logic.

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

`node --test tools/forecast-recovery.test.js` verifies freshness decisions and
publication against concurrent commits, including history preservation and
bounded conflict recovery, using temporary local Git repositories.

### Market Openings

`openings.html` tracks the five stations' next-day Polymarket US daily-high bands.
The independent `market-openings` workflow checks discovery every five minutes,
records quotes every five minutes throughout the day before the contract date,
then every 15 minutes after local midnight through 10 AM station-local time (new
bands retain five-minute first-hour sampling). GitHub scheduling is best effort;
receipt timestamps, source-update timestamps, and gaps are retained.

The first installation run is an unbracketed baseline. A later first appearance
can be bracketed by the last successful complete search plus a 404 for the
expected event. Provider `createdAt` and `openPx` statistics are separate from
observed listing and quote times. A quiet order book's old source update time is
retained, rather than treated as proof that a freshly fetched book is cached.
First-hour checkpoints allow up to ten minutes of delay; midnight/7 AM/10 AM
checkpoints allow twenty. Missing snapshots are not interpolated.

Run `node scripts/openings.js` to collect a snapshot and
`node --test tools/openings.test.js tools/openings-research.test.js` to verify date transitions, quotes, and
checkpoint behavior. State, per-event quote history, and compressed audit logs
live under `docs/data/openings/`. The latest page index includes 45 days; older
per-event files and audit logs remain available in the repository. CSV export
uses dollar prices and UTC timestamps.

Research upgrade v1.1 archives every returned bid/ask level, fractional sizes,
volume/open interest, original forecast timestamp and model version, all
degree probabilities, individual model inputs, and per-band probabilities/ranks.
Forecasts must match the station/contract date, be at most 90 minutes old, and
not be marked stale or future-dated. Unique forecasts are stored in each event's
`forecasts` map; quotes refer to them by hash. Old records keep missing forecasts
and depth rather than receiving reconstructed values. The price index remains
small by omitting full depth and model payloads; permanent per-event archives
and compressed audit logs retain them.

Each new quote includes station-local hour, elapsed minutes since first quote
and listing, and minutes until the contract-date midnight. Hypothetical YES
buy/sell sweeps at 10, 50, and 100 contracts preserve partial-depth results and
estimate fees using a timestamped standard-taker assumption stored in the event.
They do not assume maker queue fills or represent executed trades. Prices in
raw JSON/depth are integer millionths of USD; quantities are contracts. CSV
top-of-book price columns use dollars, while nested depth uses millionths.

`docs/data/openings/timing.json` gives separate station summaries by elapsed
opening window and local hour. Only completed event days with forecast leaders
captured within 20 minutes of a bracketed first quote enter those aggregates;
event days are equally weighted and missing observations remain missing.
Per-band day-before minima/maxima include all recorded bands, including losers,
and show ties. A highest bid occurring before the first ask is excluded from
the later-exit comparison. These are hindsight descriptions, not optimized
trade rules or evidence of profitability. Collection gaps and changing sample
counts must be considered in later analysis; averages across clock hours can
include different event-day cohorts. No 50-cent target is baked into collection.
The page offers YES sell prices, day-before views, research tables, CSV and full
JSON export. The active index/report covers 45 days; archived event files and
logs are not deleted.

The shared navigation list in `tools/sync-nav.js` keeps Contract Consistency and
Shadow Trader hidden (`visible = false`), without changing their pages or jobs.



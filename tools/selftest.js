/* Offline self-test: copies the repo to a temp dir and runs passes against the
   mocked feeds in tools/mockfetch.js -- a normal pass, a morning pass, a pass
   with one station down, and a pass with everything down. No network needed. */
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const src = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hightemp-"));
fs.cpSync(src, tmp, { recursive: true, filter: p => !p.includes(`${path.sep}.git`) });
const run = (env, expectOk = true) => {
  try {
    execFileSync(process.execPath, ["-r", "./tools/mockfetch.js", "scripts/run.js"],
      { cwd: tmp, env: { ...process.env, ...env }, stdio: "pipe" });
    if (!expectOk) throw new Error("expected failure");
  } catch (e) { if (expectOk) throw e; }
};
run({ MOCK_NOW: "2026-09-21T18:00:00Z" });
run({ MOCK_NOW: "2026-09-22T11:05:00Z" });
run({ MOCK_NOW: "2026-09-22T11:25:00Z", MOCK_FAIL: "KMDW" });
run({ MOCK_NOW: "2026-09-22T11:45:00Z", MOCK_FAIL: "KNYC,KMIA,KMDW,KLAX,KSFO,open-meteo" }, false);
const status = JSON.parse(fs.readFileSync(path.join(tmp, "docs/data/status.json")));
const latest = JSON.parse(fs.readFileSync(path.join(tmp, "docs/data/latest.json")));
const runs = fs.readFileSync(path.join(tmp, "docs/data/runs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const ok = runs.length >= 4 && runs.at(-1).ok === false && status.consecutiveFailures === 1
  && latest.stations.find(s => s.station === "KMDW").stale === true && latest.morning.at.startsWith("2026-09-22");
console.log(ok ? "selftest OK" : "selftest FAILED", tmp);
process.exit(ok ? 0 : 1);

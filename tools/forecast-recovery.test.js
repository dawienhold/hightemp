"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { refreshNeeded } = require("../scripts/forecast-freshness");
const { publishForecast } = require("../scripts/publish-forecast");

test("only healthy recent automatic passes are skipped", () => {
  const now = Date.parse("2026-10-03T20:20:00Z");
  const snap = { ranAt: "2026-10-03T20:10:00Z", stations:
    ["KNYC", "KMIA", "KMDW", "KLAX", "KSFO"].map(station => ({ station })) };
  for (const trigger of ["schedule", "workflow_run"]) {
    assert.equal(refreshNeeded(snap, trigger, now), false);
    assert.equal(refreshNeeded({ ...snap, ranAt: "2026-10-03T20:02:00Z" }, trigger, now), true);
    assert.equal(refreshNeeded({ ...snap, ranAt: "2026-10-03T20:21:00Z" }, trigger, now), true);
    assert.equal(refreshNeeded({ ...snap, stations: snap.stations.slice(1) }, trigger, now), true);
    assert.equal(refreshNeeded({ ...snap, stations: {} }, trigger, now), true);
    assert.equal(refreshNeeded({ ...snap, stations: snap.stations.map(s => ({ ...s, stale: true })) }, trigger, now), true);
    assert.equal(refreshNeeded({ ...snap, stations: snap.stations.map(s => ({ ...s, error: "feed failed" })) }, trigger, now), true);
    assert.equal(refreshNeeded(undefined, trigger, now), true);
  }
  assert.equal(refreshNeeded(snap, "workflow_dispatch", now), true);
  assert.equal(refreshNeeded(snap, "push", now), true);
});

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function put(cwd, file, value) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), value);
}
function commit(cwd, message) { git(cwd, "add", "."); git(cwd, "commit", "-qm", message); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", "--initial-branch=main", "origin");
  git(root, "clone", path.join(root, "origin"), "other");
  const other = path.join(root, "other");
  git(other, "config", "user.name", "test"); git(other, "config", "user.email", "test@example.invalid");
  put(other, "docs/data/latest.json", "base\n");
  put(other, "docs/data/history/2026-10.jsonl", "base\n");
  put(other, "docs/data/mlb/latest.json", "base mlb\n");
  commit(other, "initial"); git(other, "push", "origin", "main");
  git(root, "clone", path.join(root, "origin"), "worker");
  const worker = path.join(root, "worker");
  const oldEnv = process.env.GITHUB_ACTIONS; process.env.GITHUB_ACTIONS = "true";
  t.after(() => { if (oldEnv === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldEnv; });
  return { root, other, worker };
}

test("publication preserves another collector's concurrent commit", t => {
  const { other, worker, root } = fixture(t);
  put(worker, "docs/data/latest.json", "fresh forecast\n");
  put(other, "docs/data/mlb/latest.json", "fresh mlb\n");
  commit(other, "mlb"); git(other, "push", "origin", "main");
  publishForecast({ cwd: worker, regenerate() { assert.fail("unrelated files need no regeneration"); } });
  assert.equal(git(root, "--git-dir=origin", "show", "main:docs/data/latest.json"), "fresh forecast");
  assert.equal(git(root, "--git-dir=origin", "show", "main:docs/data/mlb/latest.json"), "fresh mlb");
});

test("conflicting state is recomputed on upstream, preserving published history", t => {
  const { other, worker, root } = fixture(t);
  put(worker, "docs/data/latest.json", "forecast from old state\n");
  put(worker, "docs/data/history/2026-10.jsonl", "base\nold local attempt\n");
  put(other, "docs/data/latest.json", "concurrent forecast\n");
  put(other, "docs/data/history/2026-10.jsonl", "base\nupstream call\n");
  commit(other, "concurrent forecast"); git(other, "push", "origin", "main");
  let regenerated = 0;
  publishForecast({ cwd: worker, regenerate(cwd) {
    regenerated++;
    assert.equal(fs.readFileSync(path.join(cwd, "docs/data/latest.json"), "utf8"), "concurrent forecast\n");
    put(cwd, "docs/data/latest.json", "recomputed forecast\n");
    fs.appendFileSync(path.join(cwd, "docs/data/history/2026-10.jsonl"), "recomputed call\n");
  } });
  assert.equal(regenerated, 1);
  assert.equal(git(root, "--git-dir=origin", "show", "main:docs/data/history/2026-10.jsonl"), "base\nupstream call\nrecomputed call");
  assert.equal(git(worker, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(worker, ".git/rebase-merge")), false);
});

test("persistent conflicts stop after three attempts with the rebase aborted", t => {
  const { other, worker } = fixture(t);
  let count = 0;
  function advance() {
    count++;
    put(other, "docs/data/latest.json", `remote ${count}\n`);
    commit(other, "concurrent pass " + count); git(other, "push", "origin", "main");
  }
  put(worker, "docs/data/latest.json", "local 0\n"); advance();
  assert.throws(() => publishForecast({ cwd: worker, regenerate(cwd) {
    put(cwd, "docs/data/latest.json", `local ${count}\n`); advance();
  } }), /bounded retries/);
  assert.equal(count, 3);
  assert.equal(fs.existsSync(path.join(worker, ".git/rebase-merge")), false);
  assert.equal(git(worker, "diff", "--name-only", "--diff-filter=U"), "");
});

test("unrelated staged edits cannot enter a forecast commit", t => {
  const { worker } = fixture(t);
  put(worker, "docs/data/mlb/latest.json", "unrelated edit\n"); git(worker, "add", ".");
  put(worker, "docs/data/latest.json", "fresh forecast\n");
  assert.throws(() => publishForecast({ cwd: worker }), /outside forecast ownership/);
});

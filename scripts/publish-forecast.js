"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const OWNED = ["latest.json", "stats.json", "state.json", "status.json", "runs.jsonl",
  "cli.json", "performance.json", "madis_omo.json", "history", "raw/metar"]
  .map(p => "docs/data/" + p);

function publishForecast({ cwd = path.join(__dirname, ".."), regenerate } = {}) {
  function git(...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 90000 });
    if (result.error) throw result.error;
    return result;
  }
  function must(...args) {
    const result = git(...args);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  // This reset/recompute strategy is only for a disposable Actions checkout.
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Publish requires an Actions checkout");
  if (must("branch", "--show-current") !== "main") throw new Error("Publish requires main");
  if (must("diff", "--name-only", "--diff-filter=U")) throw new Error("Checkout already has conflicts");
  must("config", "user.name", "hightemp-bot");
  must("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");

  for (let attempt = 0; attempt < 3; attempt++) {
    const files = OWNED.filter(p => fs.existsSync(path.join(cwd, p)) || git("ls-files", "--", p).stdout.trim());
    must("add", "--", ...files, ":(exclude)**/*.tmp");
    if (git("diff", "--cached", "--quiet").status === 0) {
      console.log("No forecast changes to publish.");
      return;
    }
    // Never accidentally publish another collector's uncommitted files.
    const staged = must("diff", "--cached", "--name-only").split("\n");
    if (staged.some(p => !OWNED.some(o => p === o || p.startsWith(o + "/")))) {
      throw new Error("Unexpected file staged outside forecast ownership");
    }
    must("commit", "-q", "-m", "pass " + new Date().toISOString().slice(0, 16) + "Z");

    let conflict = false;
    for (let pushAttempt = 0; pushAttempt < 3; pushAttempt++) {
      must("fetch", "-q", "origin", "main");
      const rebased = git("rebase", "origin/main");
      if (rebased.status !== 0) {
        // The old loop retried forever against this unresolved rebase. Abort
        // first; recompute state/history together instead of merging JSON cards.
        must("rebase", "--abort");
        conflict = true;
        console.warn("Forecast data changed upstream; recomputing from latest main.");
        break;
      }
      const pushed = git("push", "-q", "origin", "HEAD:main");
      if (pushed.status === 0) {
        console.log("Forecast published: " + must("rev-parse", "HEAD"));
        return;
      }
      console.warn("Publish race or push failure; fetching before retry: " + pushed.stderr.trim());
    }
    if (!conflict || attempt === 2) throw new Error("Forecast publication failed after bounded retries");
    if (!regenerate) throw new Error("Forecast conflict requires a fresh pass");
    // Other workflows own different paths. Refuse to discard any unrelated
    // local edit; successful upstream history survives intact on origin/main.
    const dirty = must("status", "--porcelain");
    if (dirty) throw new Error("Refusing recovery with uncommitted files: " + dirty);
    must("reset", "--hard", "origin/main");
    regenerate(cwd);
  }
}

if (require.main === module) {
  try {
    publishForecast({ regenerate(cwd) {
      const r = spawnSync(process.execPath, ["scripts/run.js"], { cwd, stdio: "inherit", timeout: 5 * 60000 });
      if (r.error || r.status !== 0) throw r.error || new Error("Recovery forecast failed");
    } });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { publishForecast };

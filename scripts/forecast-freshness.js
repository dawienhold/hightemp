"use strict";
const fs = require("node:fs");

const STATIONS = ["KNYC", "KMIA", "KMDW", "KLAX", "KSFO"];
function refreshNeeded(snapshot, trigger, now = Date.now()) {
  // Explicit requests and code changes always run, including morning/test inputs.
  if (trigger !== "schedule" && trigger !== "workflow_run") return true;
  const at = Date.parse(snapshot?.ranAt);
  if (!Number.isFinite(at) || at > now || now - at >= 18 * 60000) return true;
  if (!Array.isArray(snapshot.stations)) return true;
  return STATIONS.some(id => {
    const station = snapshot?.stations?.find(s => s.station === id);
    return !station || station.error || station.stale;
  });
}

if (require.main === module) {
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync("docs/data/latest.json", "utf8")); } catch (_) {}
  const needed = !!refreshNeeded(snapshot, process.env.TRIGGER);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  console.log(needed ? "Forecast refresh needed: overdue, incomplete, or explicitly requested."
    : `Healthy snapshot from ${snapshot.ranAt}; skip duplicate refresh.`);
}
module.exports = { refreshNeeded };

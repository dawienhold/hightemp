#!/usr/bin/env python3
"""Fetch free NOAA MADIS One-Minute ASOS (OMO/HFMETAR) data into JSON.

Designed for GitHub Actions. Uses NOAA's public HFMETAR directory (no paid
subscription and no API key required) and keeps a rolling cache so the Node
forecast engine can merge the high-frequency observations with METAR/NWS data.

Requires: pip install netCDF4
"""
from __future__ import annotations

import argparse
import gzip
import html.parser
import json
import math
import os
import re
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from netCDF4 import Dataset, chartostring
except Exception:
    print("netCDF4 is required. Install with: python -m pip install netCDF4", file=sys.stderr)
    raise

BASE = "https://madis-data.ncep.noaa.gov/madisPublic1/data/LDAD/hfmetar/netCDF/"
UA = "hightemp-desk/4.0 (+https://github.com/dawienhold/hightemp)"


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.hrefs = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a": return
        h = dict(attrs).get("href")
        if h: self.hrefs.append(h)


def get_bytes(url: str, timeout: int = 45) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def station_strings(v):
    a = v[:]
    try:
        out = chartostring(a)
        return [str(x).strip().replace("\x00", "") for x in out]
    except Exception:
        rows = []
        for x in a:
            if hasattr(x, "tobytes"):
                rows.append(x.tobytes().decode("ascii", "ignore").strip("\x00 "))
            else:
                rows.append(str(x).strip())
        return rows


def as_float(x):
    try:
        if getattr(x, "mask", False) is True: return None
        v = float(x)
        return v if math.isfinite(v) and abs(v) < 1e10 else None
    except Exception:
        return None


def parse_nc_gz(blob: bytes, wanted: set[str]):
    raw = gzip.decompress(blob)
    with tempfile.NamedTemporaryFile(suffix=".nc") as f:
        f.write(raw); f.flush()
        ds = Dataset(f.name, "r")
        try:
            names = ds.variables
            sid_name = next((x for x in ("stationId", "stationID", "staName") if x in names), None)
            time_name = next((x for x in ("observationTime", "timeObs", "time") if x in names), None)
            temp_name = next((x for x in ("temperature", "airTemperature") if x in names), None)
            if not sid_name or not time_name or not temp_name:
                raise RuntimeError(f"Unexpected MADIS variables; station={sid_name}, time={time_name}, temp={temp_name}")
            ids = station_strings(names[sid_name])
            times = names[time_name][:]
            temps = names[temp_name][:]
            out = {s: [] for s in wanted}
            for i, sid in enumerate(ids):
                sid = sid.upper()
                if sid not in wanted: continue
                ts = as_float(times[i]); k = as_float(temps[i])
                if ts is None or k is None: continue
                # MADIS OMO air temperature is Kelvin.
                c = k - 273.15
                fval = c * 9 / 5 + 32
                out[sid].append({
                    "t": datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z"),
                    "c": round(c, 3), "f": round(fval, 3), "source": "NOAA MADIS OMO"
                })
            return out
        finally:
            ds.close()


def load_old(path: Path):
    try:
        d = json.loads(path.read_text())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stations", default="KNYC", help="comma-separated ICAO station IDs")
    ap.add_argument("--out", default="docs/data/madis_omo.json")
    ap.add_argument("--hours", type=int, default=8, help="latest nominal hours to inspect")
    ap.add_argument("--retain-hours", type=int, default=40)
    args = ap.parse_args()
    wanted = {x.strip().upper() for x in args.stations.split(",") if x.strip()}
    out_path = Path(args.out); out_path.parent.mkdir(parents=True, exist_ok=True)

    page = get_bytes(BASE).decode("utf-8", "replace")
    p = Links(); p.feed(page)
    files = sorted({h for h in p.hrefs if re.fullmatch(r"\d{8}_\d{4}\.gz", h)})
    if not files:
        raise RuntimeError("MADIS public HFMETAR directory returned no .gz files")
    selected = files[-max(2, args.hours):]

    old = load_old(out_path)
    merged = {s: list(((old.get("stations") or {}).get(s) or [])) for s in wanted}
    got_files, errors = [], []
    for name in selected:
        try:
            rows = parse_nc_gz(get_bytes(BASE + name), wanted)
            got_files.append(name)
            for sid, vals in rows.items(): merged.setdefault(sid, []).extend(vals)
        except Exception as e:
            errors.append(f"{name}: {e}")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.retain_hours)
    latest_obs = None
    for sid in wanted:
        by_t = {}
        for r in merged.get(sid, []):
            try: dt = datetime.fromisoformat(r["t"].replace("Z", "+00:00"))
            except Exception: continue
            if dt < cutoff: continue
            by_t[r["t"]] = r
            if latest_obs is None or dt > latest_obs: latest_obs = dt
        merged[sid] = [by_t[k] for k in sorted(by_t)]

    now = datetime.now(timezone.utc)
    doc = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "source": "NOAA MADIS public HFMETAR/One-Minute ASOS",
        "sourceUrl": BASE,
        "files": got_files,
        "errors": errors,
        "latestObservation": latest_obs.isoformat().replace("+00:00", "Z") if latest_obs else None,
        "latencyMinutes": round((now - latest_obs).total_seconds()/60, 1) if latest_obs else None,
        "stations": merged,
    }
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    tmp.replace(out_path)
    counts = ", ".join(f"{s}={len(merged[s])}" for s in sorted(wanted))
    print(f"MADIS OMO: {counts}; latest={doc['latestObservation']}; latency={doc['latencyMinutes']} min; files={len(got_files)}")
    if errors: print("Warnings: " + " | ".join(errors), file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Download missing GFS slots from NOAA AWS S3 and convert to json-data format.
Usage: python3 backfill.py [--from YYYYMMDDHH] [--to YYYYMMDDHH]
By default fills all gaps found in json-data/.
"""

import os
import sys
import json
import subprocess
import tempfile
import urllib.request
import argparse
from datetime import datetime, timedelta

JAVA_HOME = os.environ.get("JAVA_HOME", "/usr/lib/jvm/default-java")
GRIB2JSON = os.path.join(os.path.dirname(__file__), "converter/bin/grib2json")
JSON_DATA_DIR = os.path.join(os.path.dirname(__file__), "json-data")
S3_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"


def round_hours(hour, interval=6):
    result = (hour // interval) * interval
    return f"{result:02d}"


def stamp_to_moment(stamp):
    return datetime.strptime(stamp, "%Y%m%d%H")


def moment_to_stamp(dt):
    return dt.strftime("%Y%m%d") + round_hours(dt.hour)


def find_gaps(start, end):
    existing = set(
        f.replace(".json", "")
        for f in os.listdir(JSON_DATA_DIR)
        if f.endswith(".json")
    )
    gaps = []
    cur = start
    while cur <= end:
        stamp = moment_to_stamp(cur)
        if stamp not in existing:
            gaps.append(cur)
        cur += timedelta(hours=6)
    return gaps


def s3_url(dt):
    date = dt.strftime("%Y%m%d")
    hour = f"{dt.hour:02d}"
    return f"{S3_BASE}/gfs.{date}/{hour}/atmos/gfs.t{hour}z.pgrb2.1p00.f000"


def filter_records(records):
    """Keep only TMP at surface and UGRD/VGRD at 10m — matches NOMADS format."""
    needed = []
    for rec in records:
        h = rec["header"]
        name = h.get("parameterNumberName", "")
        level = h.get("surface1TypeName", "")
        val = h.get("surface1Value", None)
        if name == "Temperature" and level == "Ground or water surface" and val == 0.0:
            needed.append(rec)
        elif name in ("U-component_of_wind", "V-component_of_wind") and \
                level == "Specified height level above ground" and val == 10.0:
            needed.append(rec)
    return needed


def process(dt):
    stamp = moment_to_stamp(dt)
    out_path = os.path.join(JSON_DATA_DIR, stamp + ".json")

    if os.path.exists(out_path):
        print(f"  skip {stamp} (already exists)")
        return True

    url = s3_url(dt)
    print(f"  downloading {stamp} ...", end=" ", flush=True)

    with tempfile.NamedTemporaryFile(suffix=".f000", delete=False) as grib_file:
        grib_path = grib_file.name

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as json_file:
        raw_json_path = json_file.name

    try:
        urllib.request.urlretrieve(url, grib_path)
        size_mb = os.path.getsize(grib_path) / 1024 / 1024
        print(f"{size_mb:.0f}MB", end=" ", flush=True)

        env = os.environ.copy()
        env["JAVA_HOME"] = JAVA_HOME
        result = subprocess.run(
            [GRIB2JSON, "--data", "--output", raw_json_path, "--names", "--compact", grib_path],
            env=env, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"ERROR (grib2json): {result.stderr[:200]}")
            return False

        with open(raw_json_path) as f:
            records = json.load(f)

        filtered = filter_records(records)
        if len(filtered) != 3:
            print(f"ERROR: expected 3 records, got {len(filtered)}")
            return False

        with open(out_path, "w") as f:
            json.dump(filtered, f, separators=(",", ":"))

        print(f"-> {len(filtered)} records, saved")
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        return False
    finally:
        for p in (grib_path, raw_json_path):
            try:
                os.unlink(p)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Backfill GFS data from NOAA S3")
    parser.add_argument("--from", dest="start", help="Start stamp YYYYMMDDHH")
    parser.add_argument("--to", dest="end", help="End stamp YYYYMMDDHH")
    args = parser.parse_args()

    if args.start:
        start = stamp_to_moment(args.start)
    else:
        start = datetime(2022, 1, 11, 12)

    if args.end:
        end = stamp_to_moment(args.end)
    else:
        end = datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        end = end.replace(hour=(end.hour // 6) * 6)

    print(f"Searching gaps from {start} to {end}...")
    gaps = find_gaps(start, end)
    print(f"Found {len(gaps)} missing slots\n")

    if not gaps:
        print("Nothing to do.")
        return

    ok = 0
    for dt in gaps:
        if process(dt):
            ok += 1

    print(f"\nDone: {ok}/{len(gaps)} slots downloaded successfully.")


if __name__ == "__main__":
    main()

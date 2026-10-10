"""Count buildings per area from Overture Maps (buildings theme: Google Open Buildings + Microsoft + OSM,
ODbL/CDLA), read straight from AWS Open Data (s3://overturemaps-us-west-2) with DuckDB's bbox pushdown.
Purpose: rankings should reflect where people live, not empty riverbed.

Usage: .venv/Scripts/python -I scripts/buildings.py [release]     (default release below)
Writes: data/derived/buildings_by_area.csv (h3, buildings, footprint_m2), data/derived/buildings_meta.json
"""

import json
import sys
from pathlib import Path

import duckdb
import h3

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tawitwin.grid import BBOX  # noqa: E402

RELEASE = "2026-09-23.1"
H3_RES = 8


def main(release=RELEASE):
    w, s, e, n = BBOX
    con = duckdb.connect()
    for sql in ("INSTALL spatial", "LOAD spatial", "INSTALL httpfs", "LOAD httpfs",
                "SET s3_region='us-west-2'", "SET s3_url_style='path'"):
        con.execute(sql)
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*"
    rows = con.execute(f"""
        SELECT (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat,
               ST_Area_Spheroid(ST_FlipCoordinates(geometry)) AS area_m2
        FROM read_parquet('{src}', hive_partitioning = 1)
        WHERE bbox.xmin >= {w} AND bbox.xmax <= {e} AND bbox.ymin >= {s} AND bbox.ymax <= {n}
    """).fetchall()
    counts = {}
    for lon, lat, area in rows:
        c = h3.latlng_to_cell(lat, lon, H3_RES)
        b, a = counts.get(c, (0, 0.0))
        counts[c] = (b + 1, a + (area or 0))
    out = ROOT / "data" / "derived" / "buildings_by_area.csv"
    with out.open("w", encoding="utf-8") as f:
        f.write("h3,buildings,footprint_m2\n")
        for c, (b, a) in sorted(counts.items()):
            f.write(f"{c},{b},{a:.0f}\n")
    meta = {"source": f"Overture Maps Foundation, buildings theme, release {release} (AWS Open Data)",
            "licence": "ODbL / CDLA Permissive 2.0 (per source)", "buildings": len(rows), "cells": len(counts)}
    (ROOT / "data" / "derived" / "buildings_meta.json").write_text(json.dumps(meta, indent=2))
    print(meta)


if __name__ == "__main__":
    main(*sys.argv[1:])

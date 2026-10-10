"""Port LandGuard (Oct 3 prototype) outputs into Tawi Twin web layers.

Usage:  .venv/Scripts/python -I scripts/port_landguard.py C:/path/to/LandGuard

What is carried over (origin disclosed in README):
  - Sentinel-2 land-cover change flags, Corridor A (central Tawi)
  - floodplain proxy, riverbed, nallah (drain) zone
  - Landsat summer LST + NDVI heat grid

What is deliberately dropped:
  - restricted flags/cells (within 100 m of OSM airport/military) - removed entirely
  - "river_dynamics" flags (natural channel migration, not land-cover change by people)
  - image chips (contain Esri imagery) and internal labels
"""

import json
import sys
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "layers"

FLAG_COLS = ["flag_id", "rank", "category", "context", "area_m2", "risk_score",
             "score_sensitivity", "score_size", "score_magnitude",
             "mean_d_ndvi_peak", "mean_d_ndbi", "mean_d_mndwi",
             "pct_floodplain_proxy", "pct_nallah_zone"]

LABEL = "Detected land-cover change (satellite, unverified). Not a finding of encroachment."

# ~1 m at Jammu's latitude; keeps polygons faithful at street zoom while trimming file size
SIMPLIFY_DEG = 0.00001


def write(gdf, name, precision=6):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.geojson"
    gdf.to_file(path, driver="GeoJSON", COORDINATE_PRECISION=precision, RFC7946="YES")
    print(f"{name}: {len(gdf)} features, {path.stat().st_size / 1024:.0f} KB")
    return gdf


def main(landguard):
    lg = Path(landguard) / "outputs"

    flags = gpd.read_file(lg / "corridor_a" / "flags_ranked.geojson").to_crs(4326)
    keep = flags["actionable"].astype(bool) & ~flags["category"].isin(["restricted_area", "river_dynamics"])
    keep &= ~(flags["in_airport"].astype(bool) | flags["in_military"].astype(bool))
    flags = flags.loc[keep, FLAG_COLS + ["geometry"]].copy()
    flags["rank"] = flags["rank"].astype(int)
    flags["flood_prone"] = flags["context"].isin(["floodplain_proxy", "nallah_zone"])
    flags["label"] = LABEL
    flags["geometry"] = flags.geometry.simplify(SIMPLIFY_DEG)
    write(flags.round(3), "change_flags")

    for name in ["floodplain_proxy", "riverbed", "nallah_zone", "corridor"]:
        g = gpd.read_file(lg / "corridor_a" / f"{name}.geojson").to_crs(4326)
        g["geometry"] = g.geometry.simplify(SIMPLIFY_DEG * 5)
        write(g[["geometry"]], name, precision=5)

    heat = gpd.read_file(lg / "heat" / "heat_grid.geojson").to_crs(4326)
    heat = heat[heat["eligible"].astype(bool) & ~heat["restricted"].astype(bool)]
    heat = heat[["cell_id", "lst_c", "lst_anom_c", "ndvi", "poi_n", "n_school",
                 "n_hospital", "n_clinic", "priority", "geometry"]].round(3)
    write(heat, "heat_grid", precision=5)

    summary = json.loads((lg / "heat" / "summary.json").read_text())
    meta = {
        "source": "LandGuard prototype (3 Oct 2026), ported into Tawi Twin",
        "change_flags": {
            "sensor": "Sentinel-2 L2A annual composites",
            "before": "2019-10/2020-09", "after": "2025-10/2026-09",
            "n": int(len(flags)), "n_flood_prone": int(flags["flood_prone"].sum()),
        },
        "heat": {
            "sensor": "Landsat 8/9 C2 L2 surface temperature, Apr-Jun 2024-2026 median, 500 m cells",
            "scenes": summary["scenes"], "date_range": summary["date_range"],
            "city_median_c": summary["lst_city_median_c"],
        },
        "floodplain_proxy": "Riverbed + 200 m buffer. NOT the official demarcation (not public).",
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])

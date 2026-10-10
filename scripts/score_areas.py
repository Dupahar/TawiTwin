"""Add flood evidence and hazard scores to site/layers/areas.geojson.

Per hexagon (10 m zonal stats):
  flood_2025_share   share of area under water on 27 Aug 2025 (Sentinel-1, river + new water)
  new_flood_share    share newly flooded vs 15 Aug 2025
  hand_median_m      median height above nearest drainage (Copernicus DEM 30 m)
  low_lying_share    share with HAND <= 5 m
  sink_share         share in terrain low pockets (indicative; DEM includes buildings)

Scores (0-1, transparent and NOT calibrated; percentile ranks across the 284 areas):
  flood_score = 0.35*flood_2025 + 0.25*low_lying + 0.20*floodplain + 0.10*sinks + 0.10*nallah
  heat_score  = percentile of summer LST anomaly
  combined    = mean(flood_score, heat_score); tier: high >= 0.66, medium >= 0.4, else low
  priority    = combined * building percentile (Overture buildings): hazard where people actually live,
                used for the officers' ranking. Areas with < 50 buildings are flagged sparsely_built.

Usage: .venv/Scripts/python -I scripts/score_areas.py   (after build_areas.py and flood_event.py)
"""

import json
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio import features

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tawitwin.grid import Grid  # noqa: E402

DERIVED = ROOT / "data" / "derived"
LAYERS = ROOT / "site" / "layers"

FLOOD_WEIGHTS = {"flood_2025_share": 0.35, "low_lying_share": 0.25, "floodplain_share": 0.20,
                 "sink_share": 0.10, "nallah_share": 0.10}


def load(name):
    with rasterio.open(DERIVED / name) as ds:
        return ds.read(1).astype("float32")


def pct_rank(s):
    return s.rank(pct=True, method="average").fillna(0)


def main():
    grid = Grid.jammu(10.0)
    areas = gpd.read_file(LAYERS / "areas.geojson")
    zones = features.rasterize(((g, i + 1) for i, g in enumerate(areas.to_crs(grid.crs).geometry)),
                               out_shape=grid.shape, transform=grid.transform, fill=0, dtype="int32")
    n = len(areas) + 1
    count = np.bincount(zones.ravel(), minlength=n).astype(float)
    count[count == 0] = np.nan

    def share(mask):
        return (np.bincount(zones.ravel(), weights=mask.ravel().astype(float), minlength=n) / count)[1:]

    post = load("post_water_2025_08.tif") == 1
    newf = load("flood_2025_08.tif") == 1
    hand = load("hand.tif")
    sink = load("sink_depth.tif")
    slope = load("slope_deg.tif")

    areas["flood_2025_share"] = share(post).round(3)
    areas["new_flood_share"] = share(newf).round(3)
    areas["low_lying_share"] = share(np.nan_to_num(hand, nan=99) <= 5).round(3)
    areas["sink_share"] = share((sink >= 0.5) & (np.nan_to_num(slope, nan=99) <= 5)).round(3)
    areas["hand_median_m"] = [float(np.nanmedian(hand[zones == i + 1])) if (zones == i + 1).any() else None
                              for i in range(len(areas))]
    areas["hand_median_m"] = areas["hand_median_m"].round(1)

    flood = sum(w * pct_rank(areas[c].where(areas[c] > 0)) for c, w in FLOOD_WEIGHTS.items())
    areas["flood_score"] = (flood / sum(FLOOD_WEIGHTS.values())).round(3)
    areas["heat_score"] = pct_rank(areas["lst_anom_c"]).round(3)
    areas["combined_score"] = ((areas["flood_score"] + areas["heat_score"]) / 2).round(3)
    areas["tier"] = np.select([areas["combined_score"] >= 0.66, areas["combined_score"] >= 0.4],
                              ["high", "medium"], "low")
    areas["combined_rank"] = areas["combined_score"].rank(ascending=False, method="first").astype(int)

    b = pd.read_csv(DERIVED / "buildings_by_area.csv").set_index("h3")
    areas["buildings"] = areas["h3"].map(b["buildings"]).fillna(0).astype(int)
    areas["sparsely_built"] = areas["buildings"] < 50
    areas["priority_score"] = (areas["combined_score"] * pct_rank(areas["buildings"].where(areas["buildings"] > 0))).round(3)
    areas["flood_priority_score"] = (areas["flood_score"] * pct_rank(areas["buildings"].where(areas["buildings"] > 0))).round(3)
    areas["priority_rank"] = areas["priority_score"].rank(ascending=False, method="first").astype(int)

    areas.to_file(LAYERS / "areas.geojson", driver="GeoJSON", COORDINATE_PRECISION=5, RFC7946="YES")
    top = areas.sort_values("priority_rank").head(12)
    print(top[["area_id", "name", "buildings", "flood_score", "heat_score", "priority_score", "flood_2025_share",
               "low_lying_share", "lst_c"]].to_string(index=False))
    print(areas["tier"].value_counts().to_dict())
    meta = json.loads((LAYERS / "meta.json").read_text())
    meta["scores"] = {"flood_weights": FLOOD_WEIGHTS, "note": __doc__.split("Scores")[1].split("Usage")[0].strip()}
    meta["flood_2025_08_27"] = json.loads((DERIVED / "flood_2025_08_27.json").read_text())
    (LAYERS / "meta.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()

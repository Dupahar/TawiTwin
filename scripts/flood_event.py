"""Map the 26-27 Aug 2025 Jammu flood from Sentinel-1 and export web layers.

Event: Jammu 296 mm rain in 24 h (record, IMD), Tawi above its highest flood level, 4th Tawi Bridge
(Bhagwati Nagar) damaged on 26-27 Aug 2025.
Pair (same track 100, ascending, 13:04 UTC): pre 2025-08-15, post 2025-08-27 (18:34 IST).

Usage:  .venv/Scripts/python -I scripts/flood_event.py
Writes: data/derived/*.tif, site/layers/flood_2025_08_27.geojson, site/layers/terrain_sinks.geojson,
        data/derived/flood_2025_08_27_quicklook.png, data/derived/flood_2025_08_27.json
"""

import json
import sys
from pathlib import Path

import cv2
import geopandas as gpd
import numpy as np
from rasterio import features
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tawitwin import flood, terrain  # noqa: E402
from tawitwin.grid import Grid  # noqa: E402
from tawitwin.stac import s1_scenes, signed  # noqa: E402

DERIVED = ROOT / "data" / "derived"
LAYERS = ROOT / "site" / "layers"
TRACK = 100
PRE_DAY, POST_DAY = "2025-08-15", "2025-08-27"


def scene_on(day):
    items = s1_scenes(f"{day}T00:00:00Z", f"{day}T23:59:59Z", orbit=TRACK)
    if not items:
        raise SystemExit(f"no track-{TRACK} S1 RTC scene on {day}")
    return items[0]


def read_cached(grid, item, pol):
    path = DERIVED / "s1" / f"{item.datetime:%Y%m%d}_{pol}.tif"
    if path.exists():
        return grid.read(path)
    arr = grid.read(signed(item, pol))
    grid.save(path, arr, nodata=np.nan)
    return arr


def vectorize(mask, grid, min_area_m2=0, simplify_m=5):
    geoms = [shape(g) for g, v in features.shapes(mask.astype("uint8"), mask=mask, transform=grid.transform)
             if v == 1]
    g = gpd.GeoDataFrame(geometry=geoms, crs=grid.crs)
    g["area_m2"] = g.area.round(0)
    g = g[g["area_m2"] >= min_area_m2]
    g["geometry"] = g.geometry.simplify(simplify_m)
    return g.to_crs(4326)


def quicklook(grid, post_vv, res, sinks, out):
    db = flood.to_db(post_vv)
    gray = np.clip((np.nan_to_num(db, nan=-25) + 25) / 25 * 255, 0, 255).astype("uint8")
    img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    img[res["pre_water"] & res["post_water"]] = (160, 60, 0)      # permanent / pre-existing water: dark blue
    img[res["flood"]] = (255, 200, 0)                              # new flood water: cyan
    img[sinks] = (0, 140, 255)                                     # terrain sinks: orange
    cv2.imwrite(str(out), img)


def main():
    grid = Grid.jammu(10.0)
    pre, post = scene_on(PRE_DAY), scene_on(POST_DAY)
    print("pre ", pre.id, pre.datetime)
    print("post", post.id, post.datetime)

    t = terrain.build(DERIVED / "dem", grid)
    for k in ("hand", "sink_depth", "slope_deg"):
        grid.save(DERIVED / f"{k}.tif", t[k].astype("float32"), nodata=np.nan)

    bands = {f"{tag}_{pol}": read_cached(grid, item, pol)
             for tag, item in (("pre", pre), ("post", post)) for pol in ("vv", "vh")}
    res = flood.flood_event(bands["pre_vv"], bands["pre_vh"], bands["post_vv"], bands["post_vh"],
                            t["hand"], t["slope_deg"])
    for k in ("pre_water", "post_water", "flood"):
        grid.save(DERIVED / f"{k}_2025_08.tif", res[k].astype("uint8"), nodata=255)

    px_ha = grid.res ** 2 / 1e4
    stats = {
        "event": "Jammu extreme rain and Tawi flood, 26-27 Aug 2025",
        "pre_scene": pre.id, "post_scene": post.id,
        "post_time_utc": post.datetime.isoformat(),
        "vv_threshold_db": {"pre": round(res["t_pre"], 2), "post": round(res["t_post"], 2)},
        "valid_fraction": round(float(res["valid"].mean()), 3),
        "water_pre_ha": round(float(res["pre_water"].sum() * px_ha), 1),
        "water_post_ha": round(float(res["post_water"].sum() * px_ha), 1),
        "new_flood_ha": round(float(res["flood"].sum() * px_ha), 1),
        "method": flood.__doc__.strip().splitlines()[2:8],
    }

    fl = vectorize(res["flood"], grid, min_area_m2=1000)
    fl["kind"] = "new_water"
    wet = vectorize(res["post_water"] & ~res["flood"], grid, min_area_m2=1000)
    wet["kind"] = "river_water"
    out = gpd.GeoDataFrame(gpd.pd.concat([wet, fl], ignore_index=True), crs=4326)
    out.to_file(LAYERS / "flood_2025_08_27.geojson", driver="GeoJSON", COORDINATE_PRECISION=5, RFC7946="YES")

    # Terrain sinks >= 0.5 m deep, >= 0.3 ha, on flat ground: candidate waterlogging pockets
    sinks = flood.clean((t["sink_depth"] >= 0.5) & (np.nan_to_num(t["slope_deg"], nan=99) <= 5), min_pixels=30)
    sk = vectorize(sinks, grid, min_area_m2=3000, simplify_m=10)
    sk.to_file(LAYERS / "terrain_sinks.geojson", driver="GeoJSON", COORDINATE_PRECISION=5, RFC7946="YES")
    stats["terrain_sinks"] = {"n": int(len(sk)), "area_ha": round(float(sk.to_crs(grid.crs).area.sum() / 1e4), 1)}

    quicklook(grid, bands["post_vv"], res, sinks, DERIVED / "flood_2025_08_27_quicklook.png")
    (DERIVED / "flood_2025_08_27.json").write_text(json.dumps(stats, indent=2))
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()

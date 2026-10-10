"""Per-building flood and heat exposure for Jammu, exported as vector tiles for the 3D map.

For every Overture building (AWS Open Data) in the Jammu box:
  water_2025   1 if Sentinel-1 saw water within 10 m of the footprint on 27 Aug 2025
  hand_m       height above nearest drain at the centroid (Copernicus DEM 30 m)
  lst_c        summer surface temperature at the centroid (Landsat, LandGuard heat raster)
  height_m     Overture height, else num_floors * 3.2 m, else 6 m (typical 2-storey Jammu house)
  in_floodzone 1 if inside the Tawi flood-prone zone proxy (riverbed + 200 m)
  flood_class  3 = water seen within 10 m in 2025, or in the flood-prone zone and HAND <= 3 m
               2 = in the flood-prone zone or HAND <= 3 m;  1 = HAND <= 8 m;  0 = higher ground
Writes: data/derived/buildings.parquet and site/tiles/buildings/{z}/{x}/{y}.pbf (z13-16, layer "buildings").

Usage: .venv/Scripts/python -I scripts/buildings_risk.py C:/path/to/LandGuard
"""

import gzip
import math
import sys
from pathlib import Path

import duckdb
import geopandas as gpd
import mapbox_vector_tile
import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely import box, clip_by_rect, from_wkb
from shapely.affinity import affine_transform
from scipy.ndimage import binary_dilation

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tawitwin.grid import BBOX, Grid  # noqa: E402

DERIVED = ROOT / "data" / "derived"
TILES = ROOT / "site" / "tiles" / "buildings"
RELEASE = "2026-09-23.1"
ZOOMS = range(13, 17)
EXTENT = 4096


def fetch(cache):
    if cache.exists():
        return gpd.read_parquet(cache)
    w, s, e, n = BBOX
    con = duckdb.connect()
    for sql in ("INSTALL spatial", "LOAD spatial", "INSTALL httpfs", "LOAD httpfs",
                "SET s3_region='us-west-2'", "SET s3_url_style='path'"):
        con.execute(sql)
    df = con.execute(f"""
        SELECT id, height, num_floors, ST_AsWKB(geometry) AS wkb
        FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*',
                          hive_partitioning = 1)
        WHERE bbox.xmin >= {w} AND bbox.xmax <= {e} AND bbox.ymin >= {s} AND bbox.ymax <= {n}
    """).df()
    g = gpd.GeoDataFrame(df.drop(columns="wkb"), geometry=from_wkb(df["wkb"].map(bytes)), crs=4326)
    g.to_parquet(cache)
    return g


def sample(path, xs, ys):
    with rasterio.open(path) as ds:
        return np.array([v[0] for v in ds.sample(zip(xs, ys))], dtype="float32")


def tile_bounds(z, x, y):
    n = 2 ** z
    lon0, lon1 = x / n * 360 - 180, (x + 1) / n * 360 - 180
    lat = lambda t: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * t / n))))  # noqa: E731
    return lon0, lat(y + 1), lon1, lat(y)


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def write_tiles(g):
    props = ["flood_class", "water_2025", "in_floodzone", "hand_m", "lst_c", "height_m", "area_id"]
    sidx = g.sindex
    n_tiles = 0
    for z in ZOOMS:
        x0, y0 = tile_xy(BBOX[0], BBOX[3], z)
        x1, y1 = tile_xy(BBOX[2], BBOX[1], z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                w, s, e, n = tile_bounds(z, x, y)
                bw, bh = (e - w) * 0.02, (n - s) * 0.02          # 2 % buffer avoids seams
                idx = sidx.query(box(w - bw, s - bh, e + bw, n + bh))
                if len(idx) == 0:
                    continue
                sub = g.iloc[idx]
                if z == 13:                                        # keep z13 light: larger buildings only
                    sub = sub[sub["foot_m2"] >= 120]
                geoms = clip_by_rect(sub.geometry.values, w - bw, s - bh, e + bw, n + bh)
                # lon/lat -> tile pixel coordinates (y up, mapbox_vector_tile default)
                sx, sy = EXTENT / (e - w), EXTENT / (n - s)
                feats = []
                for geom, row in zip(geoms, sub[props].itertuples(index=False)):
                    if geom.is_empty:
                        continue
                    tg = affine_transform(geom, [sx, 0, 0, sy, -w * sx, -s * sy])
                    clean = {}
                    for k, v in zip(props, row):
                        if v is None or (isinstance(v, float) and math.isnan(v)):
                            continue
                        clean[k] = round(float(v), 1) if isinstance(v, float) else v
                    feats.append({"geometry": tg.wkb, "properties": clean})
                if not feats:
                    continue
                data = mapbox_vector_tile.encode([{"name": "buildings", "features": feats}],
                                                 default_options={"extents": EXTENT, "quantize_bounds": None})
                out = TILES / str(z) / str(x) / f"{y}.pbf"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(gzip.compress(data))
                n_tiles += 1
        print(f"z{z}: done ({n_tiles} tiles so far)", flush=True)
    return n_tiles


def main(landguard):
    g = fetch(ROOT / "data" / "cache" / "overture_buildings.parquet")
    g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].reset_index(drop=True)
    utm = g.to_crs(Grid.jammu().crs)
    c = utm.geometry.centroid
    g["foot_m2"] = utm.area.round(0)

    grid = Grid.jammu(10.0)
    with rasterio.open(DERIVED / "post_water_2025_08.tif") as ds:
        water = ds.read(1) == 1
    near = binary_dilation(water, iterations=1)                      # within ~10 m
    rows, cols = rasterio.transform.rowcol(grid.transform, c.x.values, c.y.values)
    rows, cols = np.clip(rows, 0, grid.height - 1), np.clip(cols, 0, grid.width - 1)
    # footprint-level test: any 10 m cell of the (dilated) water mask under the footprint
    labels = rasterize(((geom, i + 1) for i, geom in enumerate(utm.geometry)), out_shape=grid.shape,
                       transform=grid.transform, fill=0, dtype="int32", all_touched=True)
    wet_ids = np.unique(labels[near & (labels > 0)]) - 1
    g["water_2025"] = 0
    g.loc[wet_ids, "water_2025"] = 1
    g.loc[near[rows, cols], "water_2025"] = 1

    g["hand_m"] = np.round(sample(DERIVED / "hand.tif", c.x, c.y), 1)
    lst_path = Path(landguard) / "outputs" / "heat" / "lst_summer_median_c.tif"
    with rasterio.open(lst_path) as ds:
        lc = gpd.GeoSeries(c, crs=utm.crs).to_crs(ds.crs)
    g["lst_c"] = np.round(sample(lst_path, lc.x, lc.y), 1)
    h = g["height"].astype("float").where(g["height"] > 0)
    h = h.fillna(g["num_floors"].astype("float") * 3.2).fillna(6.0).clip(3, 80)
    g["height_m"] = h.round(1)
    hand = g["hand_m"].fillna(99)
    fz = gpd.read_file(ROOT / "site" / "layers" / "floodplain_proxy.geojson").to_crs(utm.crs).union_all()
    g["in_floodzone"] = gpd.GeoSeries(c, crs=utm.crs).within(fz).astype(int).values
    fzone = g["in_floodzone"] == 1
    g["flood_class"] = np.select(
        [(g["water_2025"] == 1) | (fzone & (hand <= 3)), fzone | (hand <= 3), hand <= 8], [3, 2, 1], 0).astype(int)

    areas = gpd.read_file(ROOT / "site" / "layers" / "areas.geojson")[["area_id", "geometry"]]
    pts = gpd.GeoDataFrame(geometry=gpd.GeoSeries(c, crs=utm.crs).to_crs(4326).values, crs=4326)
    j = gpd.sjoin(pts, areas, predicate="within", how="left")
    g["area_id"] = j[~j.index.duplicated()]["area_id"].values

    keep = ["id", "foot_m2", "height_m", "water_2025", "in_floodzone", "hand_m", "lst_c", "flood_class", "area_id",
            "geometry"]
    g[keep].to_parquet(DERIVED / "buildings.parquet")
    print(g["flood_class"].value_counts().sort_index().to_dict(), "| water_2025:", int(g["water_2025"].sum()))
    g["geometry"] = g.geometry.simplify(0.000005)
    print("tiles:", write_tiles(g[keep]))


if __name__ == "__main__":
    main(sys.argv[1])

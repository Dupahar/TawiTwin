"""Build the Tawi Twin area grid: H3 hexagons (res 8, ~0.74 km2) over Jammu with names and hazard stats.

Jammu Municipal Corporation ward boundaries are not in OpenStreetMap (checked 2026-10-08 via ohsome:
the smallest boundary in the bbox is the Jammu tehsil), so hexagons stand in for wards.
Each hexagon is named after its locality (Amazon Location Service reverse geocoding), with the
nearest OSM landmark kept as a secondary hint (OSM has few named places in Jammu).

Usage:  .venv/Scripts/python -I scripts/build_areas.py
Needs:  site/layers/{heat_grid,floodplain_proxy,nallah_zone,change_flags}.geojson (scripts/port_landguard.py)
        OHSOME_API_KEY in .env
"""

import json
import os
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import requests
from shapely.geometry import Polygon, box

ROOT = Path(__file__).resolve().parents[1]
LAYERS = ROOT / "site" / "layers"
CACHE = ROOT / "data" / "cache"
BBOX = (74.78, 32.64, 74.95, 32.78)
H3_RES = 8
UTM = "EPSG:32643"
OHSOME = "https://api.heigit.org/ohsome-api/v2-rc/extraction/features.parquet"
OSM_TIME = "2026-10-01T00:00:00Z"

LANDMARK_FILTER = (
    "name=* and (amenity in (school,college,university,hospital,marketplace,bus_station,"
    "place_of_worship,police,townhall) or leisure in (park,stadium) or tourism=attraction "
    "or place in (square) or junction=yes)"
)
PLACE_FILTER = "name=* and place in (city,town,suburb,neighbourhood,quarter,village,hamlet,locality)"


def env(key):
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return os.environ[key]


def ohsome_points(name, flt):
    """Named OSM features (as representative points), cached as GeoParquet."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"osm_{name}.parquet"
    if not path.exists():
        r = requests.post(OHSOME, headers={"Authorization": env("OHSOME_API_KEY")}, timeout=240,
                          json={"aoi": list(BBOX), "time": OSM_TIME, "filter": flt, "clip": True})
        r.raise_for_status()
        path.write_bytes(r.content)
    g = gpd.read_parquet(path, to_pandas_kwargs={"maps_as_pydicts": "strict"})
    g["name"] = [t.get("name:en") or t.get("name") for t in g["tags"]]
    g["name_hi"] = [t.get("name:hi") for t in g["tags"]]
    pts = gpd.GeoDataFrame(g[["name", "name_hi"]], geometry=g.geometry.representative_point().values, crs=g.crs)
    return pts.dropna(subset=["name"]).reset_index(drop=True)


def locality_names(hexes):
    """Reverse-geocode hexagon centres with Amazon Location Service (IntendedUse=Storage, since we keep
    the result). Returns (locality, district) per hexagon; cached in data/cache/locality_names.json."""
    import boto3

    cache_path = CACHE / "locality_names.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    client = boto3.client("geo-places", region_name="ap-south-1")
    cent = hexes.to_crs(UTM).geometry.centroid.to_crs(4326)
    out = []
    for h, p in zip(hexes["h3"], cent):
        if h not in cache:
            r = client.reverse_geocode(QueryPosition=[p.x, p.y], IntendedUse="Storage", MaxResults=1)
            addr = r["ResultItems"][0]["Address"] if r.get("ResultItems") else {}
            cache[h] = [addr.get("SubDistrict"), addr.get("District") or addr.get("Locality")]
        out.append(cache[h])
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
    return pd.DataFrame(out, columns=["locality", "district"], index=hexes.index)


def hex_grid():
    cells = h3.geo_to_cells(box(*BBOX).__geo_interface__, H3_RES)
    rows = [{"h3": c, "geometry": Polygon([(lng, lat) for lat, lng in h3.cell_to_boundary(c)])} for c in cells]
    return gpd.GeoDataFrame(rows, crs=4326).sort_values("h3").reset_index(drop=True)


def overlap_share(hexes_m, layer_m):
    """Fraction of each hexagon's area covered by a (dissolved) polygon layer."""
    shape = layer_m.union_all()
    return (hexes_m.geometry.intersection(shape).area / hexes_m.geometry.area).round(3)


def area_weighted(hexes_m, grid_m, cols):
    """Area-weighted mean of grid-cell attributes per hexagon."""
    inter = gpd.overlay(hexes_m[["h3", "geometry"]], grid_m[cols + ["geometry"]], how="intersection")
    inter["w"] = inter.geometry.area
    out = {}
    for c in cols:
        ok = inter[c].notna()
        num = (inter.loc[ok, c] * inter.loc[ok, "w"]).groupby(inter.loc[ok, "h3"]).sum()
        den = inter.loc[ok, "w"].groupby(inter.loc[ok, "h3"]).sum()
        out[c] = num / den
    return pd.DataFrame(out)


def nearest_names(hexes, points, prefix):
    cent = hexes.to_crs(UTM).geometry.centroid
    pts = points.to_crs(UTM)
    j = gpd.sjoin_nearest(gpd.GeoDataFrame(geometry=cent, crs=UTM), pts, distance_col="d")
    j = j[~j.index.duplicated()]
    src = pts.geometry.loc[j["index_right"]].values
    dx = cent.x.values - np.array([p.x for p in src])
    dy = cent.y.values - np.array([p.y for p in src])
    compass = np.array(["N", "NE", "E", "SE", "S", "SW", "W", "NW"])
    bearing = compass[np.round(np.degrees(np.arctan2(dx, dy)) % 360 / 45).astype(int) % 8]
    return pd.DataFrame({f"{prefix}": j["name"], f"{prefix}_hi": j["name_hi"],
                         f"{prefix}_dist_m": j["d"].round(-1), f"{prefix}_dir": bearing}, index=j.index)


def main():
    hexes = hex_grid()
    hm = hexes.to_crs(UTM)

    heat = gpd.read_file(LAYERS / "heat_grid.geojson").to_crs(UTM)
    hexes = hexes.join(area_weighted(hm.set_index("h3", drop=False), heat, ["lst_c", "lst_anom_c", "ndvi"])
                       .round(2), on="h3")
    hexes["heat_coverage"] = overlap_share(hm, heat)
    hexes["floodplain_share"] = overlap_share(hm, gpd.read_file(LAYERS / "floodplain_proxy.geojson").to_crs(UTM))
    hexes["nallah_share"] = overlap_share(hm, gpd.read_file(LAYERS / "nallah_zone.geojson").to_crs(UTM))

    flags = gpd.read_file(LAYERS / "change_flags.geojson").to_crs(UTM)
    fp = flags[flags["flood_prone"]].copy()
    fp["geometry"] = fp.geometry.representative_point()
    j = gpd.sjoin(fp, hm[["h3", "geometry"]], predicate="within")
    agg = j.groupby("h3").agg(change_flags_flood_prone=("flag_id", "size"), change_area_ha=("area_m2", "sum"))
    agg["change_area_ha"] = (agg["change_area_ha"] / 1e4).round(2)
    hexes = hexes.join(agg, on="h3")
    hexes[["change_flags_flood_prone", "change_area_ha"]] = (
        hexes[["change_flags_flood_prone", "change_area_ha"]].fillna(0))
    hexes["change_flags_flood_prone"] = hexes["change_flags_flood_prone"].astype(int)
    # Change flags only exist inside LandGuard's Corridor A; elsewhere "no data", not "no change".
    corridor = gpd.read_file(LAYERS / "corridor.geojson").to_crs(UTM)
    hexes["change_surveyed"] = overlap_share(hm, corridor) >= 0.5

    hexes = hexes.join(nearest_names(hexes, ohsome_points("places", PLACE_FILTER), "place"))
    hexes = hexes.join(nearest_names(hexes, ohsome_points("landmarks", LANDMARK_FILTER), "landmark"))
    km = (hexes["landmark_dist_m"] / 1000).round(1).astype(str)
    hexes["name"] = np.where(hexes["landmark_dist_m"] <= 500, "Near " + hexes["landmark"],
                             km + " km " + hexes["landmark_dir"] + " of " + hexes["landmark"])
    hexes["name"] = np.where(hexes["place_dist_m"] <= 2500, hexes["name"] + ", " + hexes["place"], hexes["name"])
    hexes["landmark_name"] = hexes["name"]
    # Prefer the real locality (Amazon Location); landmark wording stays as a fallback and as a hint.
    hexes = hexes.join(locality_names(hexes))
    generic = hexes["district"].fillna("").str.contains("Sub-District")
    district = hexes["district"].where(~generic)
    hexes["name"] = np.where(hexes["locality"].notna(),
                             hexes["locality"] + np.where(district.notna(), ", " + district.fillna(""), ""),
                             np.where(district.notna(), district.fillna("") + " (" + hexes["landmark_name"] + ")",
                                      hexes["landmark_name"]))

    # Restricted hexes (airport / defence, as in LandGuard) are dropped: heat grid already excludes them.
    hexes = hexes[hexes["heat_coverage"] >= 0.5].reset_index(drop=True)
    # Stable short code in reading order (north->south rows, west->east), for officers and the chat
    c = hexes.to_crs(UTM).geometry.centroid
    order = np.lexsort((c.x.round(-1), -c.y.round(-1)))
    hexes.loc[order, "area_id"] = [f"JMU-{i + 1:03d}" for i in range(len(hexes))]

    out = LAYERS / "areas.geojson"
    hexes.to_file(out, driver="GeoJSON", COORDINATE_PRECISION=5, RFC7946="YES")
    print(f"areas: {len(hexes)} hexagons, {out.stat().st_size / 1024:.0f} KB")
    print(hexes.drop(columns="geometry").describe().round(2).T.to_string())
    print(hexes["name"].head(10).to_string())


if __name__ == "__main__":
    main()

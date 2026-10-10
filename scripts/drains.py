"""Rank drains / nallahs for pre-monsoon clearing.

Segments: OSM waterway=drain|ditch|canal|stream (ohsome, snapshot below), split into <= 250 m pieces.
Score per segment = buildings within 100 m that are flood_class >= 2 (low-lying or in the Tawi flood-prone zone)
                    x mean flood_score of the areas it passes through.
This is a triage list for officers, NOT a hydraulic model: OSM does not record drain capacity or blockage.

Usage: .venv/Scripts/python -I scripts/drains.py
Writes: site/layers/drains_priority.geojson (top segments with rank) and backend data drains.json
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import requests
from shapely.geometry import LineString
from shapely.ops import substring

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"
LAYERS = ROOT / "site" / "layers"
BACKEND = ROOT / "backend" / "layer" / "python" / "ttcore" / "data"
UTM = "EPSG:32643"
BBOX = (74.78, 32.64, 74.95, 32.78)
SEG_M = 250
TOP = 60


def env(key):
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()


def fetch():
    path = CACHE / "osm_waterways_small.parquet"
    if not path.exists():
        r = requests.post("https://api.heigit.org/ohsome-api/v2-rc/extraction/features.parquet",
                          headers={"Authorization": env("OHSOME_API_KEY")}, timeout=240,
                          json={"aoi": list(BBOX), "time": "2026-10-01T00:00:00Z", "clip": True,
                                "filter": "waterway in (drain,ditch,canal,stream) and geometry:line"})
        r.raise_for_status()
        path.write_bytes(r.content)
    g = gpd.read_parquet(path, to_pandas_kwargs={"maps_as_pydicts": "strict"})
    g = g.set_geometry(g.geometry.name)
    g["kind"] = [t.get("waterway") for t in g["tags"]]
    g["name"] = [t.get("name:en") or t.get("name") for t in g["tags"]]
    return gpd.GeoDataFrame(g[["kind", "name"]], geometry=g.geometry.values, crs=g.crs)


def split(line, step):
    if line.geom_type == "MultiLineString":
        for part in line.geoms:
            yield from split(part, step)
        return
    n = max(1, int(np.ceil(line.length / step)))
    for i in range(n):
        seg = substring(line, i * line.length / n, (i + 1) * line.length / n)
        if isinstance(seg, LineString) and seg.length > 1:
            yield seg


def main():
    w = fetch().to_crs(UTM)
    rows = [{"kind": r.kind, "name": r.name, "geometry": seg} for r in w.itertuples() for seg in split(r.geometry, SEG_M)]
    segs = gpd.GeoDataFrame(rows, crs=UTM)
    print(len(w), "waterways ->", len(segs), "segments", w["kind"].value_counts().to_dict())

    b = gpd.read_parquet(ROOT / "data" / "derived" / "buildings.parquet").to_crs(UTM)
    b = gpd.GeoDataFrame(b[["flood_class"]], geometry=b.geometry.centroid, crs=UTM)
    exposed = b[b["flood_class"] >= 2]
    buf = gpd.GeoDataFrame(geometry=segs.buffer(100), crs=UTM)
    j = gpd.sjoin(exposed, buf, predicate="within")
    segs["exposed_buildings"] = j.groupby("index_right").size().reindex(segs.index, fill_value=0)

    areas = gpd.read_file(LAYERS / "areas.geojson").to_crs(UTM)
    ja = gpd.sjoin(segs[["geometry"]], areas[["area_id", "name", "flood_score", "geometry"]], predicate="intersects")
    segs["flood_score"] = ja.groupby(level=0)["flood_score"].mean().reindex(segs.index).fillna(0)
    first = ja[~ja.index.duplicated()]
    segs["area_id"] = first["area_id"].reindex(segs.index)
    segs["area_name"] = first["name"].reindex(segs.index)
    segs["score"] = (segs["exposed_buildings"] * segs["flood_score"]).round(1)

    top = segs[segs["score"] > 0].sort_values("score", ascending=False).head(TOP).copy()
    top["rank"] = np.arange(1, len(top) + 1)
    top["length_m"] = top.length.round(0)
    cent = top.geometry.interpolate(0.5, normalized=True).to_crs(4326)
    top = top.to_crs(4326)
    top["lat"], top["lon"] = cent.y.round(5), cent.x.round(5)
    cols = ["rank", "kind", "name", "area_id", "area_name", "exposed_buildings", "flood_score", "score", "length_m"]
    top[cols + ["geometry"]].to_file(LAYERS / "drains_priority.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    recs = json.loads(top[cols + ["lat", "lon"]].round(3).to_json(orient="records"))
    (BACKEND / "drains.json").write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(top[cols].head(10).to_string(index=False))


if __name__ == "__main__":
    main()

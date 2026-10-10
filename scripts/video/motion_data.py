"""Export real Tawi Twin layers into a compact form for the motion-graphics video (video/).

Coordinates are projected to local metres around Jammu (x east, y south) so the
Remotion canvas can draw them with a simple camera transform.

Outputs (video/public/data/):
  buildings.bin   int16 x, int16 y (metres/4), uint8 class, uint8 water_2025, uint8 size  (7 bytes each, little-endian, packed)
  layers.json     areas (hexes), river, flood polygons, drains, reported places, pois

Usage: .venv/Scripts/python -I scripts/video/motion_data.py
"""

import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "video" / "public" / "data"
LON0, LAT0 = 74.865, 32.71
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540


def xy(lon, lat):
    return (lon - LON0) * KX, -(lat - LAT0) * KY


def ring(coords, tol=1.0):
    pts = [xy(x, y) for x, y in coords]
    return [[round(px, 1), round(py, 1)] for px, py in pts]


def polys(geom, simplify_deg=0.0):
    if simplify_deg:
        geom = geom.simplify(simplify_deg)
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    return [ring(p.exterior.coords) for p in parts if not p.is_empty]


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    b = gpd.read_parquet(ROOT / "data/derived/buildings.parquet")
    c = b.geometry.centroid
    x, y = xy(c.x.values, c.y.values)
    rec = np.zeros(len(b), dtype=[("x", "<i2"), ("y", "<i2"), ("cls", "u1"), ("w", "u1"), ("s", "u1")])
    rec["x"] = np.clip(np.round(x / 4), -32767, 32767)
    rec["y"] = np.clip(np.round(y / 4), -32767, 32767)
    rec["cls"] = b.flood_class.fillna(0).astype(int).values
    rec["w"] = b.water_2025.fillna(0).astype(int).values
    rec["s"] = np.clip(np.round(np.sqrt(b.foot_m2.fillna(50).values)), 1, 255)
    # draw order: low risk first so red sits on top
    rec = rec[np.argsort(rec["cls"], kind="stable")]
    (OUT / "buildings.bin").write_bytes(rec.tobytes())

    layers = {}
    a = gpd.read_file(ROOT / "site/layers/areas.geojson")
    layers["areas"] = [
        {
            "id": r.area_id,
            "name": r["name"],
            "tier": r.tier,
            "flood": round(float(r.flood_score), 3),
            "rank": int(r.priority_rank) if r.priority_rank == r.priority_rank else 999,
            "bldg": int(r.buildings) if r.buildings == r.buildings else 0,
            "c": [round(v, 1) for v in xy(r.geometry.centroid.x, r.geometry.centroid.y)],
            "p": polys(r.geometry)[0],
        }
        for _, r in a.iterrows()
    ]
    rb = gpd.read_file(ROOT / "site/layers/riverbed.geojson").geometry.iloc[0]
    layers["river"] = polys(rb, 0.00015)
    fl = gpd.read_file(ROOT / "site/layers/flood_2025_08_27.geojson")
    layers["flood"] = [p for g in fl.geometry for p in polys(g, 0.00008)]
    dr = gpd.read_file(ROOT / "site/layers/drains_priority.geojson")
    layers["drains"] = [
        {"rank": int(r["rank"]), "name": r["area_name"], "l": ring(r.geometry.coords)} for _, r in dr.iterrows()
    ]
    rp = gpd.read_file(ROOT / "site/layers/reported_2025.geojson")
    layers["reported"] = [
        {"name": r["name"], "in": bool(r.in_scope), "c": [round(v, 1) for v in xy(r.lon, r.lat)]} for _, r in rp.iterrows()
    ]
    # Bhagwati Nagar: the area the replay demo asks about
    bn = a[a["name"].fillna("").str.contains("Bhagwati", case=False)]
    if len(bn):
        r = bn.iloc[0]
        layers["bhagwati"] = {"id": r.area_id, "c": [round(v, 1) for v in xy(r.geometry.centroid.x, r.geometry.centroid.y)]}
    (OUT / "layers.json").write_text(json.dumps(layers, separators=(",", ":")), encoding="utf-8")

    print("buildings", len(rec), "areas", len(layers["areas"]), "flood polys", len(layers["flood"]),
          "drains", len(layers["drains"]), "bhagwati", layers.get("bhagwati"))
    print("extent m", float(x.min()), float(x.max()), float(y.min()), float(y.max()))
    print("classes", np.bincount(rec["cls"]))


if __name__ == "__main__":
    main()

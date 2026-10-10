"""Export compact JSON indexes for the Lambda functions (backend/layer/python/ttcore/data/).

  areas.json       per-area attributes + centroid (no geometry; lookups use nearest centroid)
  gazetteer.json   named OSM places/localities/roads/landmarks -> lat/lon, for place lookup in chat
  facilities.json  hospitals, clinics, schools, colleges with terrain height (HAND) and Aug-2025 flood flag
  event.json       27 Aug 2025 flood summary

Usage: .venv/Scripts/python -I scripts/export_backend_data.py   (after score_areas.py)
"""

import json
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tawitwin.grid import BBOX, UTM  # noqa: E402

LAYERS = ROOT / "site" / "layers"
DERIVED = ROOT / "data" / "derived"
CACHE = ROOT / "data" / "cache"
OUT = ROOT / "backend" / "layer" / "python" / "ttcore" / "data"
OHSOME = "https://api.heigit.org/ohsome-api/v2-rc/extraction/features.parquet"

GAZ_FILTER = ("name=* and (place=* or landuse=residential or amenity=* or leisure=* or tourism=* "
              "or highway in (primary,secondary,tertiary,residential,unclassified,trunk) or bridge=yes "
              "or railway=station or shop=mall)")
FAC_FILTER = "name=* and (amenity in (hospital,clinic,school,college,university) or healthcare=*)"


def env(key):
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()


def osm(name, flt):
    path = CACHE / f"osm_{name}.parquet"
    if not path.exists():
        r = requests.post(OHSOME, headers={"Authorization": env("OHSOME_API_KEY")}, timeout=240,
                          json={"aoi": list(BBOX), "time": "2026-10-01T00:00:00Z", "filter": flt, "clip": True})
        r.raise_for_status()
        path.write_bytes(r.content)
    g = gpd.read_parquet(path, to_pandas_kwargs={"maps_as_pydicts": "strict"})
    return g.set_geometry(g.geometry.name)


def kind_of(t):
    for k in ("place", "amenity", "leisure", "tourism", "highway", "railway", "shop", "healthcare"):
        if k in t:
            return f"{k}:{t[k]}"
    if t.get("landuse") == "residential":
        return "residential_area"
    return "bridge" if t.get("bridge") == "yes" else "other"


def sample(path, pts_utm):
    with rasterio.open(path) as ds:
        return np.array([v[0] for v in ds.sample([(p.x, p.y) for p in pts_utm])], dtype=float)


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    areas = gpd.read_file(LAYERS / "areas.geojson")
    c = areas.to_crs(UTM).geometry.centroid.to_crs(4326)
    recs = json.loads(areas.drop(columns="geometry").to_json(orient="records"))
    for r, p in zip(recs, c):
        r["lat"], r["lon"] = round(p.y, 5), round(p.x, 5)
    (OUT / "areas.json").write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    g = osm("gazetteer", GAZ_FILTER)
    pts = g.geometry.representative_point()
    gaz = {}
    for t, p in zip(g["tags"], pts):
        names = {t.get(k) for k in ("name", "name:en", "name:hi", "alt_name", "old_name") if t.get(k)}
        for n in names:
            key = (n.strip().lower(), kind_of(t))
            if key not in gaz:   # keep first point per name+kind (roads have many segments)
                gaz[key] = {"name": n.strip(), "kind": kind_of(t), "lat": round(p.y, 5), "lon": round(p.x, 5)}
    (OUT / "gazetteer.json").write_text(json.dumps(list(gaz.values()), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    f = osm("facilities", FAC_FILTER)
    fp = gpd.GeoSeries(f.geometry.representative_point().values, crs=f.crs)
    fu = fp.to_crs(UTM)
    hand = sample(DERIVED / "hand.tif", fu)
    flooded = sample(DERIVED / "post_water_2025_08.tif", fu)
    fac = []
    for t, p, h, fl in zip(f["tags"], fp, hand, flooded):
        kind = t.get("amenity") or t.get("healthcare")
        fac.append({"name": t.get("name:en") or t.get("name"), "kind": kind, "lat": round(p.y, 5),
                    "lon": round(p.x, 5), "hand_m": None if not np.isfinite(h) else round(float(h), 1),
                    "water_27aug2025": bool(fl == 1)})
    (OUT / "facilities.json").write_text(json.dumps(fac, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    (OUT / "event.json").write_text((DERIVED / "flood_2025_08_27.json").read_text(), encoding="utf-8")
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size / 1024:.0f} KB")
    print(len(recs), "areas,", len(gaz), "gazetteer names,", len(fac), "facilities")


if __name__ == "__main__":
    main()

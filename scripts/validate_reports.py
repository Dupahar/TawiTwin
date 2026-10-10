"""Check Tawi Twin's flood exposure against localities reported flooded on 26-27 Aug 2025.

Ground truth = localities named in published reports (verified by reading the source text):
  - Onmanorama, 27 Aug 2025: "20-30 localities in Jammu and Samba were inundated, including Peerkho, Gujjar Nagar,
    RS Pura, Nikki Tawi, Beli Charan, Gurkhanagar, Qasim Nagar, Rajiv Nagar, Akhnoor and Pargwal ..."
  - Sphere India SitRep 02, 28 Aug 2025: "most severely affected areas include Jammu, Samba, Katra, Peerkho, and Nikki Tawi"
  - News On AIR, 27 Aug 2025: major damage to the 4th Tawi bridge "in the Bhagwati Nagar area" (damage site)
RS Pura, Akhnoor and Pargwal are outside the mapped box and are reported as out of scope.

For each locality (geocoded with Amazon Location Service) we look at buildings within 500 m and report the share in
flood_class >= 2 (high / very high), and compare it with the same share for ALL buildings in the city (base rate).
Caveats: 8 places is a small, non-random sample of severe sites near the Tawi, and our classes use the Tawi
flood-prone proxy, so this is a sanity check, not an accuracy estimate.

Usage: .venv/Scripts/python -I scripts/validate_reports.py
Writes: site/layers/reported_2025.geojson, data/derived/validation_2025.json
"""

import json
from pathlib import Path

import boto3
import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

ROOT = Path(__file__).resolve().parents[1]
UTM = "EPSG:32643"
BBOX = (74.78, 32.64, 74.95, 32.78)
SOURCES = {
    "onmanorama": "https://www.onmanorama.com/news/india/2025/08/27/jammu-floods-over-3500-resuced-by-army-ndrf-personnel.html",
    "sphere_sitrep02": "https://www.sphereindia.org.in/sites/default/files/2025-09/SitRep_02-_J&K_Cloudburst,_Flood,_and_Landslide_28-08-2025[1].pdf",
    "newsonair": "https://www.newsonair.gov.in/incessant-rains-wreak-havoc-across-jammu-division-in-past-40-hours",
}
PLACES = [
    ("Peerkho", "Peer Kho, Jammu", ["onmanorama", "sphere_sitrep02"], "inundated"),
    ("Nikki Tawi", "Nikki Tawi, Jammu", ["onmanorama", "sphere_sitrep02"], "inundated"),
    ("Gujjar Nagar", "Gujjar Nagar, Jammu", ["onmanorama"], "inundated"),
    ("Beli Charan", "Belicharana, Jammu", ["onmanorama"], "inundated"),
    ("Gurkha Nagar", "Gurkha Nagar, Jammu", ["onmanorama"], "inundated"),
    ("Qasim Nagar", "Qasim Nagar, Jammu", ["onmanorama"], "inundated"),
    ("Rajiv Nagar", "Rajiv Nagar, Jammu", ["onmanorama"], "inundated"),
    ("Bhagwati Nagar", "Bhagwati Nagar, Jammu", ["newsonair"], "bridge damaged"),
    ("RS Pura", "R S Pura, Jammu", ["onmanorama"], "inundated"),
    ("Akhnoor", "Akhnoor, Jammu", ["onmanorama"], "inundated"),
    ("Pargwal", "Pargwal, Jammu", ["onmanorama"], "inundated"),
]
RADIUS_M = 500


def geocode(client, query):
    r = client.geocode(QueryText=query, BiasPosition=[74.86, 32.71], Filter={"IncludeCountries": ["IND"]},
                       MaxResults=1, IntendedUse="Storage")
    item = (r.get("ResultItems") or [None])[0]
    if not item:
        return None
    return {"matched": item["Title"], "type": item.get("PlaceType"), "lon": item["Position"][0], "lat": item["Position"][1]}


def main():
    client = boto3.client("geo-places", region_name="ap-south-1")
    b = gpd.read_parquet(ROOT / "data" / "derived" / "buildings.parquet").to_crs(UTM)
    b = gpd.GeoDataFrame(b[["flood_class", "water_2025", "in_floodzone"]], geometry=b.geometry.centroid, crs=UTM)
    base_high = float((b["flood_class"] >= 2).mean())
    base_vhigh = float((b["flood_class"] == 3).mean())
    areas = gpd.read_file(ROOT / "site" / "layers" / "areas.geojson")

    rows = []
    for name, query, srcs, what in PLACES:
        g = geocode(client, query)
        row = {"name": name, "reported": what, "sources": [SOURCES[s] for s in srcs], **(g or {})}
        # RS Pura the town (~25 km SW) geocodes to "R S Pura Road" inside the city: a false match, out of scope.
        wrong_match = g and name == "RS Pura" and "Road" in g["matched"]
        if not g or wrong_match or not (BBOX[0] <= g["lon"] <= BBOX[2] and BBOX[1] <= g["lat"] <= BBOX[3]):
            row["in_scope"] = False
            rows.append(row)
            continue
        row["in_scope"] = True
        p = gpd.GeoSeries([Point(g["lon"], g["lat"])], crs=4326).to_crs(UTM).iloc[0]
        near = b[b.geometry.distance(p) <= RADIUS_M]
        a = areas[areas.contains(Point(g["lon"], g["lat"]))]
        row.update({
            "buildings_within_500m": int(len(near)),
            "pct_high_or_very_high": round(100 * float((near["flood_class"] >= 2).mean()), 1) if len(near) else None,
            "pct_very_high": round(100 * float((near["flood_class"] == 3).mean()), 1) if len(near) else None,
            "radar_water_within_500m": bool(near["water_2025"].any()),
            "area_id": a["area_id"].iloc[0] if len(a) else None,
            "area_tier": a["tier"].iloc[0] if len(a) else None,
            "area_flood_score": float(a["flood_score"].iloc[0]) if len(a) else None,
        })
        rows.append(row)

    df = pd.DataFrame(rows)
    ins = df[df["in_scope"]]
    hit = ins["pct_high_or_very_high"] >= 50
    summary = {
        "places_checked": int(len(df)), "in_scope": int(len(ins)),
        "in_scope_with_majority_high_or_very_high_buildings": int(hit.sum()),
        "mean_pct_high_or_very_high_near_reported": round(float(ins["pct_high_or_very_high"].mean()), 1),
        "city_base_rate_pct_high_or_very_high": round(100 * base_high, 1),
        "mean_pct_very_high_near_reported": round(float(ins["pct_very_high"].mean()), 1),
        "city_base_rate_pct_very_high": round(100 * base_vhigh, 1),
        "radius_m": RADIUS_M,
        "caveat": "Small non-random sample of severe sites near the Tawi; sanity check, not an accuracy estimate.",
    }
    out = {"summary": summary, "places": rows}
    (ROOT / "data" / "derived" / "validation_2025.json").write_text(json.dumps(out, indent=2, ensure_ascii=False),
                                                                    encoding="utf-8")
    pts = gpd.GeoDataFrame(ins.drop(columns=["sources"]).assign(source=ins["sources"].map(lambda s: s[0])),
                           geometry=[Point(x, y) for x, y in zip(ins["lon"], ins["lat"])], crs=4326)
    pts.to_file(ROOT / "site" / "layers" / "reported_2025.geojson", driver="GeoJSON")
    backend = [{k: r.get(k) for k in ("name", "reported", "lat", "lon", "sources")} for r in rows if r.get("in_scope")]
    (ROOT / "backend" / "layer" / "python" / "ttcore" / "data" / "reported_2025.json").write_text(
        json.dumps(backend, ensure_ascii=False), encoding="utf-8")
    print(df[["name", "in_scope", "matched", "buildings_within_500m", "pct_high_or_very_high", "pct_very_high",
              "radar_water_within_500m", "area_tier"]].to_string(index=False))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

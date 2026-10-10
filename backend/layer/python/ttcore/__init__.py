"""Tawi Twin shared backend logic (Lambda layer): data lookups, alert rules, place search.

Pure standard library + boto3 (bundled in the Lambda runtime), so every function can import it.
"""

import difflib
import json
import math
import os
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).parent / "data"
BBOX = (74.78, 32.64, 74.95, 32.78)
AREA_MATCH_MAX_M = 700          # a point further than this from every area centre is "outside the map"

# IMD 24-hour rainfall categories (mm), from IMD weather terminology
IMD_RAIN = [(204.5, "extremely heavy"), (115.6, "very heavy"), (64.5, "heavy"), (15.6, "moderate"),
            (2.5, "light"), (0.1, "very light"), (0.0, "none")]


@lru_cache(maxsize=None)
def _load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def areas():
    return _load("areas.json")


@lru_cache(maxsize=None)
def areas_by_id():
    return {a["area_id"]: a for a in areas()}


def event():
    return _load("event.json")


def haversine_m(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def in_bbox(lat, lon):
    return BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]


def locate(lat, lon):
    """Area containing (approximately: nearest centre of the regular hex grid) a point, or None."""
    best = min(areas(), key=lambda a: haversine_m(lat, lon, a["lat"], a["lon"]))
    return best if haversine_m(lat, lon, best["lat"], best["lon"]) <= AREA_MATCH_MAX_M else None


# ---------------- place search ----------------

def _gazetteer_match(q):
    q = q.strip().lower()
    gaz = _load("gazetteer.json")
    exact = [g for g in gaz if g["name"].lower() == q]
    if exact:
        return exact[0]
    contains = [g for g in gaz if q in g["name"].lower()]
    if contains:
        return min(contains, key=lambda g: len(g["name"]))
    names = [g["name"].lower() for g in gaz]
    close = difflib.get_close_matches(q, names, n=1, cutoff=0.85)
    return gaz[names.index(close[0])] if close else None


def _amazon_location(q):
    import boto3

    client = boto3.client("geo-places", region_name=os.environ.get("AWS_REGION", "ap-south-1"))
    r = client.geocode(QueryText=f"{q}, Jammu", BiasPosition=[74.86, 32.71],
                       Filter={"IncludeCountries": ["IND"]}, MaxResults=1)
    items = r.get("ResultItems") or []
    if not items:
        return None
    lon, lat = items[0]["Position"]
    return {"name": items[0]["Title"], "kind": items[0].get("PlaceType", "place"), "lat": lat, "lon": lon}


def find_place(q):
    """Resolve a place name in Jammu. Amazon Location first (knows colonies OSM lacks), OSM gazetteer
    as fallback. Returns {name, kind, lat, lon, source, area} or {error}."""
    hit, source = None, None
    try:
        hit, source = _amazon_location(q), "Amazon Location Service"
    except Exception as e:  # noqa: BLE001 - fall back to the local gazetteer on any service error
        print("location error:", repr(e))
    if not hit or not in_bbox(hit["lat"], hit["lon"]):
        hit, source = _gazetteer_match(q), "OpenStreetMap"
    if not hit:
        return {"error": f"Could not find '{q}' in Jammu."}
    if not in_bbox(hit["lat"], hit["lon"]):
        return {"error": f"'{hit['name']}' is outside the mapped part of Jammu."}
    area = locate(hit["lat"], hit["lon"])
    return {**hit, "source": source, "area_id": area["area_id"] if area else None}


# ---------------- facilities ----------------

REFUGE_KINDS = ("school", "college", "university")


def nearby_facilities(lat, lon, kinds=("hospital", "clinic", "school", "college"), n=3, high_ground=False):
    """Nearest named facilities; high_ground=True keeps schools/colleges >= 5 m above nearest drainage and
    dry on 27 Aug 2025 (candidate refuges like the schools typically used as relief camps, NOT official)."""
    if high_ground:
        kinds = REFUGE_KINDS
    out = []
    for f in _load("facilities.json"):
        if f["kind"] not in kinds:
            continue
        if high_ground and ((f["hand_m"] or 0) < 5 or f["water_27aug2025"]):
            continue
        out.append({**f, "distance_m": round(haversine_m(lat, lon, f["lat"], f["lon"]), -1)})
    return sorted(out, key=lambda f: f["distance_m"])[:n]


# ---------------- alerts ----------------

def rain_category(mm24):
    return next(label for limit, label in IMD_RAIN if mm24 >= limit)


def waterlogging_level(flood_score, mm24, max_mm_h):
    """Transparent rule, not a hydraulic model:
    city rain trigger (IMD heavy >= 64.5 mm/24 h, or an hourly burst >= 20 mm) x local susceptibility."""
    trigger = 2 if mm24 >= 115.6 else 1 if (mm24 >= 64.5 or max_mm_h >= 20) else 0
    trigger_low = mm24 >= 15.6 or max_mm_h >= 10
    if trigger == 2:
        return "high" if flood_score >= 0.4 else "medium"
    if trigger == 1:
        return "high" if flood_score >= 0.66 else "medium" if flood_score >= 0.4 else "low"
    if trigger_low and flood_score >= 0.66:
        return "medium"
    return "low"


def heat_level(tmax_c, heat_score):
    """IMD plains heatwave: Tmax >= 40 C with departure, severe at >= 45 C. Local LST anomaly bumps one level."""
    base = 2 if tmax_c >= 45 else 1 if tmax_c >= 40 else 0
    if base and heat_score >= 0.8:
        base = min(2, base + 1)
    return ["low", "medium", "high"][base]


def reported_near(lat, lon, radius_m=1000):
    """Localities named in Aug 2025 news / situation reports as inundated (or damaged) within radius_m."""
    out = []
    for r in _load("reported_2025.json"):
        d = haversine_m(lat, lon, r["lat"], r["lon"])
        if d <= radius_m:
            out.append({"locality": r["name"], "reported": r["reported"], "distance_m": round(d, -1),
                        "source": r["sources"][0]})
    return sorted(out, key=lambda x: x["distance_m"])


def radar_label(share):
    if share >= 0.15:
        return "radar saw substantial water here on 27 Aug 2025"
    if share >= 0.03:
        return "radar saw some water here on 27 Aug 2025"
    if share > 0:
        return "radar saw a little water here on 27 Aug 2025"
    return "radar saw no open water here on 27 Aug 2025 (it can miss water between buildings)"


def area_report(area_id, forecast=None):
    a = areas_by_id().get(area_id)
    if not a:
        return {"error": f"Unknown area {area_id}"}
    ev = event()
    report = {
        "area_id": a["area_id"], "name": a["name"], "lat": a["lat"], "lon": a["lon"],
        "buildings": a["buildings"], "sparsely_built": a["sparsely_built"],
        "flood_evidence": {
            "event": ev["event"],
            "pct_of_area_radar_saw_water": round(100 * a["flood_2025_share"], 1),
            "pct_of_area_newly_flooded": round(100 * a["new_flood_share"], 1),
            "radar_summary": radar_label(a["flood_2025_share"]),
            "note": "Sentinel-1 radar, 27 Aug 2025 18:34 IST, vs 15 Aug. Radar under-detects water between buildings.",
        },
        "terrain": {"median_height_above_nearest_drain_m": a["hand_median_m"],
                    "pct_of_area_within_5m_of_drain_level": round(100 * a["low_lying_share"], 1),
                    "pct_of_area_in_tawi_flood_prone_zone": round(100 * a["floodplain_share"], 1)},
        "heat": {"summer_surface_temp_c": a["lst_c"], "vs_city_median_c": a["lst_anom_c"], "greenness_ndvi": a["ndvi"]},
        "land_cover_change_in_flood_prone_zone": (
            {"flags": a["change_flags_flood_prone"], "area_ha": a["change_area_ha"]}
            if a["change_surveyed"] else "not surveyed"),
        "scores_0_to_1_relative_to_other_jammu_areas": {
            "flood": a["flood_score"], "heat": a["heat_score"], "combined": a["combined_score"], "tier": a["tier"],
            "people_weighted_priority_rank_of_284": a["priority_rank"]},
        "reported_in_news_aug_2025": reported_near(a["lat"], a["lon"]),
        "nearest_hospitals": nearby_facilities(a["lat"], a["lon"], ("hospital",), n=2),
        "high_ground_refuges": nearby_facilities(a["lat"], a["lon"], n=2, high_ground=True),
    }
    if forecast:
        f = forecast.get("areas", {}).get(area_id)
        if f:
            report["forecast_48h"] = {**f, "issued": forecast["issued"], "source": forecast["source"]}
            if forecast.get("mode") == "replay":
                report["forecast_48h"]["REPLAY"] = ("This is a replay of 26-27 Aug 2025, not today's weather: "
                                                    + forecast["window"])
    return report


# ---------------- forecast store ----------------

def latest_forecast(mode="live"):
    """Latest forecast written by the forecast function (DynamoDB), or None.
    mode="replay" returns the 26-27 Aug 2025 replay (archived forecasts) instead."""
    import boto3

    table = os.environ.get("TABLE_NAME")
    if not table:
        return None
    sk = "replay-2025-08-26" if mode == "replay" else "latest"
    item = boto3.resource("dynamodb").Table(table).get_item(Key={"pk": "forecast", "sk": sk}).get("Item")
    return json.loads(item["body"]) if item else None


# ---------------- officers: situation summary ----------------

def drains(n=10):
    """Top drain stretches, merged per area (segments of one drain are listed once, with their count)."""
    out = {}
    for d in _load("drains.json"):
        key = (d["area_id"], d["kind"], d.get("name"))
        if key not in out:
            out[key] = {**d, "segments": 1}
        else:
            out[key]["segments"] += 1
            out[key]["exposed_buildings"] = max(out[key]["exposed_buildings"], d["exposed_buildings"])
    return list(out.values())[:n]


def situation(forecast):
    """Command-centre summary for the current (or replay) forecast: what is at risk and where to act first."""
    if not forecast:
        return {"error": "forecast not available"}
    fa = forecast.get("areas", {})
    level = lambda a: fa.get(a["area_id"], {}).get("waterlogging", "low")  # noqa: E731
    by = {"high": [], "medium": [], "low": []}
    for a in areas():
        by[level(a)].append(a)
    exposed_facilities = []
    for f in _load("facilities.json"):
        if f["kind"] not in ("hospital", "school", "college", "university"):
            continue
        low_lying = f["water_27aug2025"] or (f["hand_m"] is not None and f["hand_m"] <= 5)
        a = locate(f["lat"], f["lon"]) if low_lying else None
        if a and level(a) == "high":
            exposed_facilities.append({**f, "area_id": a["area_id"], "area_name": a["name"]})
    # pumps: where heavy rain meets low-lying, dense neighbourhoods
    candidates = by["high"] + by["medium"]
    pumps = sorted((a for a in candidates if not a["sparsely_built"]),
                   key=lambda a: a["low_lying_share"] * a["buildings"] * (2 if level(a) == "high" else 1),
                   reverse=True)[:6]
    return {
        "mode": forecast.get("mode", "live"), "issued": forecast["issued"], "window": forecast.get("window"),
        "city_forecast": forecast["city"],
        "areas": {k: len(v) for k, v in by.items()},
        "buildings_in_high_alert_areas": sum(a["buildings"] for a in by["high"]),
        "buildings_in_medium_alert_areas": sum(a["buildings"] for a in by["medium"]),
        "low_lying_hospitals_schools_in_high_alert_areas": exposed_facilities[:15],
        "suggested_pump_positions": [
            {"area_id": a["area_id"], "name": a["name"], "lat": a["lat"], "lon": a["lon"], "buildings": a["buildings"],
             "pct_low_lying": round(100 * a["low_lying_share"]), "alert": level(a)} for a in pumps],
        "drains_to_clear_first": drains(8),
        "note": "Triage aid from public data; thresholds indicative. Not a substitute for JMC/SDMA field assessment.",
    }

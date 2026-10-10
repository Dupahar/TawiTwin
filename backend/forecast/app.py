"""Scheduled (EventBridge, hourly): pull a 48 h forecast from Open-Meteo and store per-area alerts in DynamoDB.

Open-Meteo (CC BY 4.0) is queried on a 3x3 point lattice over Jammu; each area takes its nearest point.
The models behind it are ~2-11 km, so a finer lattice would add no information.
"""

import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import boto3

import ttcore

TABLE = os.environ.get("TABLE_NAME", "")
LATS = [32.66, 32.71, 32.76]
LONS = [74.80, 74.865, 74.93]
URL = "https://api.open-meteo.com/v1/forecast"
# Replay: archived model forecasts (stitched short-range runs) for the 26-27 Aug 2025 event. This approximates
# what forecasts showed in the hours before; it is not the exact forecast issued on 25 Aug.
REPLAY_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
REPLAY = {"start_date": "2025-08-26", "end_date": "2025-08-27"}


def fetch(replay=False):
    pts = [(la, lo) for la in LATS for lo in LONS]
    params = {
        "latitude": ",".join(str(p[0]) for p in pts), "longitude": ",".join(str(p[1]) for p in pts),
        "hourly": "precipitation,precipitation_probability,temperature_2m,apparent_temperature",
        "timezone": "Asia/Kolkata",
    }
    params.update(REPLAY if replay else {"forecast_hours": 48})
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{REPLAY_URL if replay else URL}?{q}", timeout=20) as r:
        data = json.loads(r.read())
    return pts, data if isinstance(data, list) else [data]


def summarise(h):
    p = [x or 0 for x in h["precipitation"]]
    t = [x for x in h["temperature_2m"] if x is not None]
    at = [x for x in h["apparent_temperature"] if x is not None]
    pp = [x or 0 for x in h.get("precipitation_probability") or []]
    peak = max(range(len(p)), key=p.__getitem__) if p else 0
    return {
        "rain_0_24h_mm": round(sum(p[:24]), 1), "rain_24_48h_mm": round(sum(p[24:48]), 1),
        "max_rain_mm_h": round(max(p, default=0), 1), "peak_rain_time": h["time"][peak] if p else None,
        "max_rain_probability": max(pp, default=0),
        "tmax_c": round(max(t, default=0), 1), "feels_like_max_c": round(max(at, default=0), 1),
    }


def build(replay=False):
    pts, data = fetch(replay)
    lattice = [summarise(d["hourly"]) for d in data]
    out, counts = {}, {"waterlogging": {"high": 0, "medium": 0, "low": 0}, "heat": {"high": 0, "medium": 0, "low": 0}}
    for a in ttcore.areas():
        i = min(range(len(pts)), key=lambda k: ttcore.haversine_m(a["lat"], a["lon"], *pts[k]))
        f = lattice[i]
        mm24 = max(f["rain_0_24h_mm"], f["rain_24_48h_mm"])
        wl = ttcore.waterlogging_level(a["flood_score"], mm24, f["max_rain_mm_h"])
        ht = ttcore.heat_level(f["tmax_c"], a["heat_score"])
        counts["waterlogging"][wl] += 1
        counts["heat"][ht] += 1
        out[a["area_id"]] = {**f, "rain_category": ttcore.rain_category(mm24), "waterlogging": wl, "heat": ht}
    city = {k: round(max(x[k] for x in lattice), 1) for k in ("rain_0_24h_mm", "rain_24_48h_mm", "max_rain_mm_h", "tmax_c")}
    city["rain_category"] = ttcore.rain_category(max(city["rain_0_24h_mm"], city["rain_24_48h_mm"]))
    fc = {
        "issued": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "source": "Open-Meteo (CC BY 4.0), best-match models",
        "city": city, "counts": counts, "areas": out,
    }
    if replay:
        fc.update(mode="replay", window="2025-08-26 00:00 to 2025-08-28 00:00 IST", issued="2025-08-26T00:00+05:30",
                  source="Open-Meteo historical forecast archive (CC BY 4.0): archived model forecasts, "
                         "approximates what forecasts showed; the IMD gauge recorded 296 mm in 24 h")
    return fc


def handler(event, context):
    replay = bool((event or {}).get("replay"))
    fc = build(replay)
    table = boto3.resource("dynamodb").Table(TABLE)
    body = json.dumps(fc, separators=(",", ":"))
    if replay:
        table.put_item(Item={"pk": "forecast", "sk": "replay-2025-08-26", "body": body})
        return {"replay": True, "counts": fc["counts"], "city": fc["city"]}
    table.put_item(Item={"pk": "forecast", "sk": "latest", "body": body})
    table.put_item(Item={"pk": "forecast", "sk": fc["issued"], "body": json.dumps({"city": fc["city"], "counts": fc["counts"]}),
                         "ttl": int(time.time()) + 14 * 86400})
    print(json.dumps({"city": fc["city"], "counts": fc["counts"]}))
    return {"issued": fc["issued"], "counts": fc["counts"]}

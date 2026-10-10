"""Tawi Twin HTTP API (single Lambda, routed by API Gateway HTTP API)."""

import json
import os
from datetime import datetime, timezone

import ttcore


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "max-age=60"},
        "body": json.dumps(body, ensure_ascii=False),
    }


def _q(event, key):
    return (event.get("queryStringParameters") or {}).get(key)


def health(event):
    return _response(200, {
        "status": "ok",
        "service": "tawi-twin",
        "version": os.environ.get("APP_VERSION", "dev"),
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })


def _mode(event):
    return "replay" if _q(event, "mode") == "replay" else "live"


def alerts(event):
    fc = ttcore.latest_forecast(_mode(event))
    if not fc:
        return _response(503, {"error": "forecast not available yet"})
    compact = {k: {"w": v["waterlogging"], "h": v["heat"]} for k, v in fc["areas"].items()}
    return _response(200, {"mode": fc.get("mode", "live"), "window": fc.get("window"), "issued": fc["issued"],
                           "source": fc["source"], "city": fc["city"], "counts": fc["counts"], "areas": compact})


def area(event):
    area_id = (event.get("pathParameters") or {}).get("id", "").upper()
    rep = ttcore.area_report(area_id, ttcore.latest_forecast(_mode(event)))
    return _response(404 if "error" in rep else 200, rep)


def locate(event):
    try:
        lat, lon = float(_q(event, "lat")), float(_q(event, "lon"))
    except (TypeError, ValueError):
        return _response(400, {"error": "lat and lon are required numbers"})
    a = ttcore.locate(lat, lon)
    if not a:
        return _response(404, {"error": "outside the mapped part of Jammu"})
    return _response(200, ttcore.area_report(a["area_id"], ttcore.latest_forecast(_mode(event))))


def place(event):
    q = (_q(event, "q") or "").strip()
    if not 2 <= len(q) <= 80:
        return _response(400, {"error": "q must be 2-80 characters"})
    hit = ttcore.find_place(q)
    return _response(404 if "error" in hit else 200, hit)


def situation(event):
    rep = ttcore.situation(ttcore.latest_forecast(_mode(event)))
    return _response(503 if "error" in rep else 200, rep)


ROUTES = {
    "GET /health": health,
    "GET /alerts": alerts,
    "GET /areas/{id}": area,
    "GET /locate": locate,
    "GET /place": place,
    "GET /situation": situation,
}


def handler(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if route is None:
        return _response(404, {"error": "not found"})
    return route(event)

"""Citizen waterlogging reports with AI photo triage.

POST /reports/upload   -> presigned S3 POST for one JPEG/PNG photo (<= 5 MB)
POST /reports          {photo_key, lat, lon, note?} -> Bedrock vision triage, stored in DynamoDB
GET  /reports          latest reports (photos via short-lived presigned URLs)
PATCH /reports/{id}    {status: new|assigned|resolved|rejected}, header x-officer-key (demo officer auth)

Privacy: no names, phone numbers or IP addresses are stored with a report.
"""

import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config

import ttcore

TABLE = os.environ["TABLE_NAME"]
BUCKET = os.environ["REPORTS_BUCKET"]
VISION_MODEL = os.environ.get("VISION_MODEL_ID", "apac.amazon.nova-pro-v1:0")
OFFICER_KEY = os.environ.get("OFFICER_KEY", "")
STATUSES = {"new", "assigned", "resolved", "rejected"}

REGION = os.environ.get("AWS_REGION", "ap-south-1")
# Regional endpoint + SigV4: the global endpoint 307-redirects uploads to new buckets, which browsers refuse (CORS).
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com",
                  config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
ddb = boto3.resource("dynamodb").Table(TABLE)
brt = boto3.client("bedrock-runtime")

TRIAGE_PROMPT = """You are triaging a citizen photo sent to a city's flood control room in Jammu, India.
Look only at the photo. Reply with ONLY a JSON object, no other text:
{"waterlogging": true|false, "depth": "none|ankle|knee|waist_or_more|unclear",
 "blocked_drain": true|false, "garbage_or_debris": true|false, "vehicles_stuck": true|false,
 "people_at_risk": true|false, "severity": 1-5, "summary": "<= 20 words, plain English"}
Severity: 1 no water; 2 puddles; 3 road waterlogged, passable; 4 knee-deep or traffic stopped; 5 danger to life.
If the photo is not of a street, drain or water, set waterlogging false, severity 1 and say so in summary."""


def _resp(status, body):
    return {"statusCode": status, "headers": {"content-type": "application/json"},
            "body": json.dumps(body, ensure_ascii=False, default=str)}


def upload_url(event):
    key = f"reports/{datetime.now(timezone.utc):%Y/%m/%d}/{uuid.uuid4().hex}.jpg"
    post = s3.generate_presigned_post(
        BUCKET, key, ExpiresIn=300,
        Conditions=[["content-length-range", 1000, 5_000_000], ["starts-with", "$Content-Type", "image/"]])
    return _resp(200, {"key": key, "url": post["url"], "fields": post["fields"]})


def triage(photo_bytes, fmt):
    r = brt.converse(
        modelId=VISION_MODEL,
        messages=[{"role": "user", "content": [
            {"image": {"format": fmt, "source": {"bytes": photo_bytes}}},
            {"text": TRIAGE_PROMPT}]}],
        inferenceConfig={"maxTokens": 300, "temperature": 0})
    text = r["output"]["message"]["content"][0]["text"]
    m = re.search(r"\{.*\}", text, re.S)
    out = json.loads(m.group(0)) if m else {}
    out["severity"] = max(1, min(5, int(out.get("severity", 1))))
    out["model"] = VISION_MODEL
    return out


def create(event):
    body = json.loads(event.get("body") or "{}")
    key = str(body.get("photo_key", ""))
    if not re.fullmatch(r"reports/\d{4}/\d{2}/\d{2}/[0-9a-f]{32}\.jpg", key):
        return _resp(400, {"error": "invalid photo_key"})
    try:
        lat, lon = float(body["lat"]), float(body["lon"])
    except (KeyError, TypeError, ValueError):
        return _resp(400, {"error": "lat and lon are required"})
    if not ttcore.in_bbox(lat, lon):
        return _resp(400, {"error": "Reports are accepted only inside the mapped part of Jammu."})
    obj = s3.get_object(Bucket=BUCKET, Key=key)
    photo = obj["Body"].read()
    fmt = "png" if photo[:4] == b"\x89PNG" else "jpeg"
    try:
        ai = triage(photo, fmt)
    except Exception as e:  # noqa: BLE001 - a report must never be lost because triage failed
        print("triage error:", repr(e))
        ai = {"severity": None, "summary": "AI triage unavailable", "error": True}
    area = ttcore.locate(lat, lon)
    now = datetime.now(timezone.utc)
    rid = uuid.uuid4().hex[:12]
    item = {
        "pk": "report", "sk": f"{now.isoformat(timespec='seconds')}#{rid}", "id": rid,
        "created": now.isoformat(timespec="seconds"), "lat": str(round(lat, 5)), "lon": str(round(lon, 5)),
        "area_id": area["area_id"] if area else None, "area_name": area["name"] if area else None,
        "note": str(body.get("note", ""))[:280], "photo_key": key, "status": "new",
        "ai": json.dumps(ai), "ttl": int(time.time()) + 90 * 86400,
    }
    ddb.put_item(Item={k: v for k, v in item.items() if v is not None})
    return _resp(201, _public(item))


def _public(item):
    ai = json.loads(item.get("ai") or "{}")
    url = s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": item["photo_key"]}, ExpiresIn=600)
    return {"id": item["id"], "created": item["created"], "lat": float(item["lat"]), "lon": float(item["lon"]),
            "area_id": item.get("area_id"), "area_name": item.get("area_name"), "note": item.get("note", ""),
            "status": item["status"], "ai": ai, "photo_url": url}


def list_reports(event):
    r = ddb.query(KeyConditionExpression="pk = :p", ExpressionAttributeValues={":p": "report"},
                  ScanIndexForward=False, Limit=60)
    return _resp(200, {"reports": [_public(i) for i in r.get("Items", [])]})


def update(event):
    if not OFFICER_KEY or (event.get("headers") or {}).get("x-officer-key") != OFFICER_KEY:
        return _resp(403, {"error": "officer key required"})
    rid = (event.get("pathParameters") or {}).get("id", "")
    status = json.loads(event.get("body") or "{}").get("status")
    if status not in STATUSES:
        return _resp(400, {"error": f"status must be one of {sorted(STATUSES)}"})
    r = ddb.query(KeyConditionExpression="pk = :p", ExpressionAttributeValues={":p": "report"},
                  ScanIndexForward=False, Limit=200)
    item = next((i for i in r.get("Items", []) if i["id"] == rid), None)
    if not item:
        return _resp(404, {"error": "report not found"})
    ddb.update_item(Key={"pk": "report", "sk": item["sk"]}, UpdateExpression="SET #s = :s, updated = :u",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":s": status, ":u": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    item["status"] = status
    return _resp(200, _public(item))


ROUTES = {"POST /reports/upload": upload_url, "POST /reports": create, "GET /reports": list_reports,
          "PATCH /reports/{id}": update}


def handler(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if not route:
        return _resp(404, {"error": "not found"})
    try:
        return route(event)
    except json.JSONDecodeError:
        return _resp(400, {"error": "invalid JSON"})

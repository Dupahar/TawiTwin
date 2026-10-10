"""Sentinel-1 water and flood mapping (VV/VH backscatter, change detection, terrain screening).

Method (standard SAR flood practice, e.g. UN-SPIDER recommended practice; thresholds documented here):
  1. RTC gamma0 -> dB, 5x5 median speckle filter (OpenCV).
  2. Water = VV below a scene-adaptive Otsu threshold (clamped to [-20, -15] dB) AND VH below -22 dB.
  3. Flood (new water) = water on the post-event image, not water before, AND a VV drop >= 3 dB.
  4. Terrain screening: HAND <= 15 m and slope <= 8 deg (removes radar shadow on hills).
  5. OpenCV morphological opening + connected components >= MIN_PIXELS to drop speckle noise.
Known limit: flooded built-up areas often stay bright in SAR (double bounce), so urban flooding is
under-detected. Results are a lower bound inside dense neighbourhoods.
"""

import cv2
import numpy as np

VV_CLAMP = (-20.0, -15.0)
VH_WATER_MAX = -22.0
DROP_DB = 3.0
HAND_MAX = 15.0
SLOPE_MAX = 8.0
MIN_PIXELS = 10   # 1000 m2 at 10 m


def to_db(lin):
    with np.errstate(divide="ignore", invalid="ignore"):
        db = 10 * np.log10(lin)
    db[~np.isfinite(db)] = np.nan
    return db


def despeckle(db):
    filled = np.where(np.isfinite(db), db, -30).astype("float32")
    out = cv2.medianBlur(filled, 5)
    out[~np.isfinite(db)] = np.nan
    return out


def otsu_db(db, lo=-30.0, hi=5.0):
    """Otsu threshold on a dB image via OpenCV (scaled to 8-bit)."""
    v = db[np.isfinite(db)]
    v = np.clip(v, lo, hi)
    u8 = ((v - lo) / (hi - lo) * 255).astype("uint8").reshape(-1, 1)
    t, _ = cv2.threshold(u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return lo + t / 255 * (hi - lo)


def water_mask(vv_db, vh_db):
    t = float(np.clip(otsu_db(vv_db), *VV_CLAMP))
    return (vv_db < t) & (vh_db < VH_WATER_MAX), t


def clean(mask, min_pixels=MIN_PIXELS):
    m = mask.astype("uint8")
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_pixels
    return keep[lab]


def terrain_ok(hand, slope):
    return (np.nan_to_num(hand, nan=99) <= HAND_MAX) & (np.nan_to_num(slope, nan=99) <= SLOPE_MAX)


def flood_event(pre_vv, pre_vh, post_vv, post_vh, hand, slope):
    """All inputs linear gamma0 / terrain arrays on one grid. Returns masks + thresholds."""
    pv, ph = despeckle(to_db(pre_vv)), despeckle(to_db(pre_vh))
    qv, qh = despeckle(to_db(post_vv)), despeckle(to_db(post_vh))
    pre_w, t_pre = water_mask(pv, ph)
    post_w, t_post = water_mask(qv, qh)
    ok = terrain_ok(hand, slope)
    flood = post_w & ~pre_w & ((qv - pv) <= -DROP_DB) & ok
    return {
        "pre_water": clean(pre_w & ok),
        "post_water": clean(post_w & ok),
        "flood": clean(flood),
        "valid": np.isfinite(pv) & np.isfinite(qv),
        "t_pre": t_pre, "t_post": t_post,
    }

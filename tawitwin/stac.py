"""Scene search on Microsoft Planetary Computer (free Sentinel-1 RTC and Copernicus DEM COGs)."""

import planetary_computer as pc
import pystac_client

from .grid import BBOX

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
_client = None


def client():
    global _client
    if _client is None:
        _client = pystac_client.Client.open(STAC_URL)
    return _client


def s1_scenes(start, end, orbit=None, bbox=BBOX):
    """Sentinel-1 RTC items over the bbox, oldest first. orbit = relative orbit (track) filter."""
    items = list(client().search(collections=["sentinel-1-rtc"], bbox=list(bbox),
                                 datetime=f"{start}/{end}").items())
    if orbit is not None:
        items = [i for i in items if i.properties.get("sat:relative_orbit") == orbit]
    return sorted(items, key=lambda i: i.datetime)


def dem_hrefs(bbox=BBOX):
    items = client().search(collections=["cop-dem-glo-30"], bbox=list(bbox)).items()
    return [pc.sign(i.assets["data"].href) for i in items]


def signed(item, asset):
    return pc.sign(item.assets[asset].href)

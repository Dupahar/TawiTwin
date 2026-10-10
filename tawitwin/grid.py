"""Common analysis grid for Jammu and helpers to read any raster (COG URL or file) onto it."""

from dataclasses import dataclass

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds

BBOX = (74.78, 32.64, 74.95, 32.78)   # same box as LandGuard's heat grid and area hexagons
UTM = CRS.from_epsg(32643)


@dataclass(frozen=True)
class Grid:
    crs: CRS
    transform: rasterio.Affine
    width: int
    height: int

    @classmethod
    def jammu(cls, res=10.0):
        w, s, e, n = transform_bounds("EPSG:4326", UTM, *BBOX)
        w, s = np.floor(w / res) * res, np.floor(s / res) * res
        e, n = np.ceil(e / res) * res, np.ceil(n / res) * res
        return cls(UTM, from_origin(w, n, res, res), int((e - w) / res), int((n - s) / res))

    @property
    def res(self):
        return self.transform.a

    @property
    def shape(self):
        return self.height, self.width

    def read(self, src, band=1, resampling=Resampling.bilinear):
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="4",
                          GDAL_HTTP_RETRY_DELAY="2"):
            with rasterio.open(src) as ds, WarpedVRT(ds, crs=self.crs, transform=self.transform,
                                                    width=self.width, height=self.height,
                                                    resampling=resampling) as vrt:
                arr = vrt.read(band, masked=True).astype("float32")
        return arr.filled(np.nan)

    def save(self, path, arr, nodata=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        prof = dict(driver="GTiff", crs=self.crs, transform=self.transform, width=self.width,
                    height=self.height, count=1, dtype=arr.dtype.name, compress="deflate",
                    tiled=True, nodata=nodata)
        with rasterio.open(path, "w", **prof) as dst:
            dst.write(arr, 1)

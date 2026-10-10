"""Terrain layers from Copernicus DEM GLO-30: height above nearest drainage (HAND) and sink depth.

HAND: how far (vertically) a pixel sits above the stream it drains to. Low HAND = water reaches it easily.
Sink depth: depth of closed depressions (filled DEM - DEM). Where rain has nowhere to drain -> waterlogging.
"""

from pathlib import Path

import numpy as np
from rasterio.enums import Resampling
from rasterio.merge import merge
import rasterio

from .grid import Grid
from .stac import dem_hrefs

STREAM_THRESHOLD_CELLS = 400   # ~0.36 km2 upstream area at 30 m: keeps nallahs, not every gully


def build(workdir: Path, grid10: Grid):
    """Returns dict of float32 arrays on grid10: dem, hand, sink_depth, slope_deg."""
    import whitebox

    workdir.mkdir(parents=True, exist_ok=True)
    g30 = Grid.jammu(res=30.0)
    dem_path = workdir / "dem30.tif"
    if not dem_path.exists():
        hrefs = dem_hrefs()
        if len(hrefs) == 1:
            dem = g30.read(hrefs[0])
        else:
            mosaic = workdir / "dem_mosaic.tif"
            srcs = [rasterio.open(h) for h in hrefs]
            arr, tr = merge(srcs)
            prof = srcs[0].profile | {"height": arr.shape[1], "width": arr.shape[2], "transform": tr}
            with rasterio.open(mosaic, "w", **prof) as dst:
                dst.write(arr)
            dem = g30.read(mosaic)
        g30.save(dem_path, dem.astype("float32"), nodata=-9999)

    wbt = whitebox.WhiteboxTools()
    wbt.set_verbose_mode(False)
    wbt.set_working_dir(str(workdir.resolve()))
    steps = [
        ("filled.tif", lambda o: wbt.fill_depressions("dem30.tif", o)),
        ("breached.tif", lambda o: wbt.breach_depressions_least_cost("dem30.tif", o, dist=30, fill=True)),
        ("d8.tif", lambda o: wbt.d8_pointer("breached.tif", o)),
        ("acc.tif", lambda o: wbt.d8_flow_accumulation("breached.tif", o, out_type="cells")),
        ("streams.tif", lambda o: wbt.extract_streams("acc.tif", o, threshold=STREAM_THRESHOLD_CELLS)),
        ("hand.tif", lambda o: wbt.elevation_above_stream("breached.tif", "streams.tif", o)),
        ("slope.tif", lambda o: wbt.slope("dem30.tif", o, units="degrees")),
    ]
    for out, fn in steps:
        if not (workdir / out).exists():
            fn(out)
            if not (workdir / out).exists():
                raise RuntimeError(f"whitebox step failed: {out}")

    def up(name, resampling=Resampling.bilinear):
        return grid10.read(workdir / name, resampling=resampling)

    dem = up("dem30.tif")
    sink = up("filled.tif") - dem
    return {
        "dem": dem,
        "hand": np.clip(up("hand.tif"), 0, None),
        "sink_depth": np.where(sink > 0.05, sink, 0).astype("float32"),
        "slope_deg": up("slope.tif"),
        "streams": up("streams.tif", Resampling.nearest) > 0,
    }

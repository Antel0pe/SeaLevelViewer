# era5_mean_sst_to_rgb.py
#
# Usage:
#   python era5_mean_sst_to_rgb.py ../data/avgSST1990-2010.nc out.png

import sys
import numpy as np
import xarray as xr
from PIL import Image


def main():
    if len(sys.argv) != 3:
        print("Usage: python era5_mean_sst_to_rgb.py input.nc out.png")
        sys.exit(1)

    nc_path = sys.argv[1]
    out_path = sys.argv[2]

    ds = xr.open_dataset(nc_path)
    da = ds["sst"]

    # Mask GRIB missing values
    missing = da.attrs.get("GRIB_missingValue")
    if missing is not None:
        da = da.where(da != missing)

    # Average over time
    mean_sst = da.mean(dim="valid_time", skipna=True)
    arr = mean_sst.values.astype(np.float32)

    # Robust normalization
    finite = arr[np.isfinite(arr)]
    lo = np.quantile(finite, 0.01)
    hi = np.quantile(finite, 0.99)

    t = (arr - lo) / (hi - lo)
    t = np.clip(t, 0.0, 1.0)

    # ---- RGB mapping ----
    # cold (t=0)  -> blue
    # hot  (t=1)  -> red
    r = (255 * t).astype(np.uint8)
    g = (255 * (1.0 - np.abs(2.0 * t - 1.0))).astype(np.uint8)
    b = (255 * (1.0 - t)).astype(np.uint8)

    # Land / NaN -> black
    nanmask = ~np.isfinite(arr)
    r[nanmask] = 0
    g[nanmask] = 0
    b[nanmask] = 0

    rgb = np.stack([r, g, b], axis=-1)

    Image.fromarray(rgb, mode="RGB").save(out_path)

    print("ERA5 SST mean → RGB")
    print(f"Input:  {nc_path}")
    print(f"Output: {out_path}")
    print(f"Scale:  {lo:.2f} K (blue) → {hi:.2f} K (red)")


if __name__ == "__main__":
    main()

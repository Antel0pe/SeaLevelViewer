# evap_precip_mean_to_png.py
#
# Step 2/2: read the mean NetCDF and render a PNG:
#   Red  = evaporation amount (upward, so we use evap_pos = max(-e_mean, 0))
#   Blue = precipitation amount (tp_mean clipped >= 0)
# Both share a robust vmax (99th percentile over both), with optional gamma boost for low values.
#
# Assumes mean file latitude is ascending (south->north). If so, we flipud for north-up PNG.

import io
import os
import numpy as np
import xarray as xr
from PIL import Image
from dotenv import load_dotenv
from pathlib import Path


def resolve_paths():
    load_dotenv()

    era5_raw_dir = Path(os.environ["ERA5_RAW_DIR"])
    scripts_dir = Path(os.environ["SEA_LEVEL_SCRIPTS_DIR"])

    mean_nc = era5_raw_dir / "evap-precip-climatology-mean.nc"
    out_png = scripts_dir / "era5_evap_precip_mean.png"

    out_png.parent.mkdir(parents=True, exist_ok=True)
    return mean_nc, out_png

def scale_0_to_vmax(a: np.ndarray, vmax: float) -> np.ndarray:
    a = a.astype(np.float32, copy=False)
    out = np.zeros_like(a, dtype=np.uint8)
    if not np.isfinite(vmax) or vmax <= 0:
        return out

    scaled = np.clip(a / float(vmax), 0.0, 1.0)
    out = (scaled * 255.0).astype(np.uint8)
    out[~np.isfinite(a)] = 0
    return out


def scale_0_to_vmax_power(a: np.ndarray, vmax: float, gamma: float = 0.5) -> np.ndarray:
    a = a.astype(np.float32, copy=False)
    out = np.zeros_like(a, dtype=np.uint8)

    if not np.isfinite(vmax) or vmax <= 0:
        return out

    scaled = np.clip(a / float(vmax), 0.0, 1.0)
    scaled = np.power(scaled, float(gamma))
    out = (scaled * 255.0).astype(np.uint8)
    out[~np.isfinite(a)] = 0
    return out


def encode_evap_precip_png(evap_pos: np.ndarray, precip: np.ndarray, vmax: float, gamma: float) -> bytes:
    r = scale_0_to_vmax_power(evap_pos, vmax, gamma=gamma)
    g = np.zeros_like(r, dtype=np.uint8)
    b = scale_0_to_vmax_power(precip, vmax, gamma=gamma)
    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, g, b, a])
    img = Image.fromarray(rgba, mode="RGBA")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def _maybe_flip_for_north_up(ds: xr.Dataset, a: np.ndarray) -> np.ndarray:
    """
    PIL row 0 is top. If latitude increases south->north, north is at bottom -> flipud.
    If latitude decreases north->south, already north-up -> no flip.
    """
    for lat_name in ["latitude", "lat", "y"]:
        if lat_name in ds.coords and ds[lat_name].ndim == 1:
            latv = ds[lat_name].values
            if latv.size >= 2 and (latv[1] - latv[0]) > 0:
                return np.flipud(a)
            return a
    return a


def main():
    mean_nc, out_png = resolve_paths()

    if not os.path.exists(mean_nc):
        raise FileNotFoundError(f"Mean file not found: {mean_nc}")

    ds = xr.open_dataset(mean_nc)

    if "e_mean" not in ds.variables or "tp_mean" not in ds.variables:
        raise KeyError(
            f"Expected variables e_mean and tp_mean in {mean_nc}. Found: {list(ds.variables.keys())}"
        )

    e_mean = ds["e_mean"].values.astype(np.float32, copy=False)
    tp_mean = ds["tp_mean"].values.astype(np.float32, copy=False)

    if e_mean.ndim != 2 or tp_mean.ndim != 2:
        raise RuntimeError(f"Expected 2D arrays, got e_mean={e_mean.shape}, tp_mean={tp_mean.shape}")

    # Convert ERA5 convention: evaporation often negative for upward flux.
    evap_pos = (-1.0) * e_mean

    # Clip to nonnegative “amounts”
    evap_pos = np.where(np.isfinite(evap_pos), np.maximum(evap_pos, 0.0), np.nan).astype(np.float32)
    precip = np.where(np.isfinite(tp_mean), np.maximum(tp_mean, 0.0), np.nan).astype(np.float32)

    # Shared robust vmax across both fields
    combo = np.concatenate([evap_pos[np.isfinite(evap_pos)].ravel(),
                            precip[np.isfinite(precip)].ravel()])
    if combo.size == 0:
        raise ValueError("No finite values found in mean fields.")

    vmax = float(np.nanpercentile(combo, 99))
    vmax = max(vmax, 1e-9)

    # Gamma boost for low values (tweak if you want)
    GAMMA = 0.5

    # Flip for north-up display if needed
    evap_pos = _maybe_flip_for_north_up(ds, evap_pos)
    precip = _maybe_flip_for_north_up(ds, precip)

    png_bytes = encode_evap_precip_png(evap_pos, precip, vmax=vmax, gamma=GAMMA)

    with open(out_png, "wb") as f:
        f.write(png_bytes)

    print(f"Wrote PNG: {out_png}")
    print(f"Evap+ (after *-1, clipped>=0) min/max: [{float(np.nanmin(evap_pos)):.6g}, {float(np.nanmax(evap_pos)):.6g}]")
    print(f"Precip (clipped>=0)         min/max: [{float(np.nanmin(precip)):.6g}, {float(np.nanmax(precip)):.6g}]")
    print(f"Shared color scale vmax (99th pct of both): {vmax:.6g}")
    print(f"Gamma (power-law): {GAMMA}")
    print("Color mapping: Red=evaporation, Blue=precipitation (same 0..vmax scale).")


if __name__ == "__main__":
    main()

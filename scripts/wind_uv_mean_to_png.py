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

    mean_nc = era5_raw_dir / "uv-1981-2010-mean_850.nc"
    out_png = scripts_dir / "era5_850_uv_mean.png"

    out_png.parent.mkdir(parents=True, exist_ok=True)

    return mean_nc, out_png



def uv850_to_hue_value_rgba(u: np.ndarray, v: np.ndarray,
                           vmax_mps: float = 20.0,
                           sat: float = 0.8,
                           gamma: float = 0.7,
                           calm_mps: float = 0.8) -> np.ndarray:
    """
    850 hPa wind visualization:
      Hue   = direction atan2(v,u)
      Value = speed normalized by vmax_mps (clipped), with gamma compression
      Sat   = constant sat
      Calm  = speeds below calm_mps set to black (no hue noise)

    Returns RGBA uint8 image (H,W,4).
    """
    u = u.astype(np.float32)
    v = v.astype(np.float32)

    spd = np.sqrt(u*u + v*v)
    theta = np.arctan2(v, u)                 # [-pi, pi]
    h = (theta + np.pi) / (2.0 * np.pi)      # [0, 1)

    # Value from speed (fixed scale)
    val = np.clip(spd / float(vmax_mps), 0.0, 1.0)
    val = np.power(val, float(gamma))

    # Calm masking
    val = np.where(spd < float(calm_mps), 0.0, val)
    s = np.where(val > 0.0, float(sat), 0.0).astype(np.float32)

    # HSV -> RGB (vectorized)
    i = np.floor(h * 6.0).astype(np.int32) % 6
    f = (h * 6.0) - np.floor(h * 6.0)
    p = val * (1.0 - s)
    q = val * (1.0 - s * f)
    t = val * (1.0 - s * (1.0 - f))

    r = np.zeros_like(val, dtype=np.float32)
    g = np.zeros_like(val, dtype=np.float32)
    b = np.zeros_like(val, dtype=np.float32)

    m = (i == 0); r[m], g[m], b[m] = val[m], t[m], p[m]
    m = (i == 1); r[m], g[m], b[m] = q[m], val[m], p[m]
    m = (i == 2); r[m], g[m], b[m] = p[m], val[m], t[m]
    m = (i == 3); r[m], g[m], b[m] = p[m], q[m], val[m]
    m = (i == 4); r[m], g[m], b[m] = t[m], p[m], val[m]
    m = (i == 5); r[m], g[m], b[m] = val[m], p[m], q[m]

    rgb = np.stack([r, g, b], axis=-1)
    rgb_u8 = (np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    a = np.full((*rgb_u8.shape[:2], 1), 255, dtype=np.uint8)

    rgba = np.concatenate([rgb_u8, a], axis=-1)

    # NaNs -> black
    valid = np.isfinite(u) & np.isfinite(v)
    rgba[~valid] = np.array([0, 0, 0, 255], dtype=np.uint8)

    return rgba

def uv850_to_hue_sat_rgba(u: np.ndarray, v: np.ndarray,
                         vmax_mps: float = 20.0,
                         value_const: float = 0.9,
                         gamma: float = 0.7,
                         calm_mps: float = 0.8) -> np.ndarray:
    s_min = 0.4
    s_max = 0.6

    u = u.astype(np.float32)
    v = v.astype(np.float32)

    spd = np.sqrt(u*u + v*v)
    theta = np.arctan2(v, u)                 # [-pi, pi]
    h = (theta + np.pi) / (2.0 * np.pi)      # [0, 1)

    s = np.clip(spd / float(vmax_mps), 0.0, 1.0)
    s = np.power(s, float(gamma))
    s = s_min + (s_max - s_min) * s
    s = np.where(spd < float(calm_mps), 0.0, s).astype(np.float32)

    val = np.full_like(s, float(value_const), dtype=np.float32)

    i = np.floor(h * 6.0).astype(np.int32) % 6
    f = (h * 6.0) - np.floor(h * 6.0)
    p = val * (1.0 - s)
    q = val * (1.0 - s * f)
    t = val * (1.0 - s * (1.0 - f))

    r = np.zeros_like(val, dtype=np.float32)
    g = np.zeros_like(val, dtype=np.float32)
    b = np.zeros_like(val, dtype=np.float32)

    m = (i == 0); r[m], g[m], b[m] = val[m], t[m], p[m]
    m = (i == 1); r[m], g[m], b[m] = q[m], val[m], p[m]
    m = (i == 2); r[m], g[m], b[m] = p[m], val[m], t[m]
    m = (i == 3); r[m], g[m], b[m] = p[m], q[m], val[m]
    m = (i == 4); r[m], g[m], b[m] = t[m], p[m], val[m]
    m = (i == 5); r[m], g[m], b[m] = val[m], p[m], q[m]

    rgb = np.stack([r, g, b], axis=-1)
    rgb_u8 = (np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    a = np.full((*rgb_u8.shape[:2], 1), 255, dtype=np.uint8)
    rgba = np.concatenate([rgb_u8, a], axis=-1)

    valid = np.isfinite(u) & np.isfinite(v)
    rgba[~valid] = np.array([0, 0, 0, 255], dtype=np.uint8)
    return rgba


def _maybe_flip_for_north_up(ds: xr.Dataset, rgba: np.ndarray) -> np.ndarray:
    """
    PIL assumes row 0 is the top of the image.
    If latitude is increasing (south->north), then north is at the bottom -> flipud.
    If latitude is decreasing (north->south), already north-up -> no flip.
    """
    for lat_name in ["latitude", "lat"]:
        if lat_name in ds.coords and ds[lat_name].ndim == 1:
            latv = ds[lat_name].values
            if latv.size >= 2 and (latv[1] - latv[0]) > 0:
                return np.flipud(rgba)
            return rgba
    # If no lat coord, keep as-is.
    return rgba


def main():
    mean_nc, out_png = resolve_paths()

    if not os.path.exists(mean_nc):
        raise FileNotFoundError(f"Mean file not found: {mean_nc}")

    ds = xr.open_dataset(mean_nc)
    if "u_mean" not in ds.variables or "v_mean" not in ds.variables:
        raise KeyError(f"Expected variables u_mean and v_mean in {mean_nc}. Found: {list(ds.variables.keys())}")

    u = ds["u_mean"].values
    v = ds["v_mean"].values
    if u.ndim != 2 or v.ndim != 2:
        raise RuntimeError(f"Expected 2D arrays, got u={u.shape}, v={v.shape}")

    rgba = uv850_to_hue_value_rgba(u, v, vmax_mps=20.0, sat=0.9, gamma=0.3, calm_mps=0.7)
    # rgba = uv850_to_hue_sat_rgba(u, v, vmax_mps=20.0, value_const=0.7, gamma=0.3, calm_mps=0.8)
    rgba = _maybe_flip_for_north_up(ds, rgba)

    Image.fromarray(rgba, mode="RGBA").save(out_png)

    print(f"Wrote PNG: {out_png}")
    print(f"U mean range: [{float(np.nanmin(u)):.3f}, {float(np.nanmax(u)):.3f}] m/s")
    print(f"V mean range: [{float(np.nanmin(v)):.3f}, {float(np.nanmax(v)):.3f}] m/s")


if __name__ == "__main__":
    main()

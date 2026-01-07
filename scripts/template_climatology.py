import io
import os
import numpy as np
import xarray as xr
from PIL import Image
from dask.diagnostics import ProgressBar
from dotenv import load_dotenv
from pathlib import Path

def resolve_paths():
    load_dotenv()

    projects_dir = Path(os.environ["PROJECTS_DIR"])
    downloads_dir = Path(os.environ["DOWNLOADS_DIR"])

    nc_path = projects_dir / "uv-1981-2010-data.nc"
    out_png = downloads_dir / "era5_850_uv_mean.png"

    out_png.parent.mkdir(parents=True, exist_ok=True)

    return nc_path, out_png


def open_dataset(path: str, time_chunk: int = 32) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"ERA5 NetCDF file not found: {path}")

    # Chunk over time so dask can stream + parallelize without loading everything.
    # decode_times=False can be a small speed win if you never use actual datetimes.
    # Keep decode_times=True if you prefer; either works for mean.
    ds = xr.open_dataset(path, chunks={"time": time_chunk}, decode_times=False)

    return ds


def pick_var_name(ds: xr.Dataset, candidates: list[str]) -> str:
    for c in candidates:
        if c in ds.variables:
            return c
    raise KeyError(f"None of these variables were found: {candidates}. Found: {list(ds.variables.keys())}")


def select_level_component(ds: xr.Dataset, var_name: str, level_hpa: int) -> xr.DataArray:
    if var_name not in ds.variables:
        raise KeyError(f"Variable '{var_name}' not found in dataset")
    da = ds[var_name]

    dims = set(da.dims)
    if "level" in dims:
        da = da.sel(level=level_hpa)
    elif "pressure_level" in dims:
        da = da.sel(pressure_level=level_hpa)
    elif "isobaricInhPa" in dims:
        da = da.sel(isobaricInhPa=level_hpa)

    # Keep latitude increasing (south->north) for consistent output
    for lat_name in ["latitude", "lat"]:
        if lat_name in da.coords and da[lat_name].ndim == 1:
            latv = da[lat_name].values
            if np.any(np.diff(latv) < 0):
                da = da.sortby(lat_name)
            break

    return da


def scale_fixed_range(a: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    a = a.astype(np.float32, copy=False)
    out = np.zeros_like(a, dtype=np.uint8)
    if not np.isfinite(vmin) or not np.isfinite(vmax) or vmax <= vmin:
        return out
    scaled = (a - vmin) / (vmax - vmin)
    scaled = np.clip(scaled * 255.0, 0.0, 255.0)
    out = scaled.astype(np.uint8)
    out[~np.isfinite(a)] = 0
    return out


UV_RANGES_MPS = {
    850: (-60.0, 60.0),
    500: (-80.0, 80.0),
    250: (-120.0, 120.0),
}


def encode_uv_avg_rgb_png(u_mean: np.ndarray, v_mean: np.ndarray, pressure_level: int) -> bytes:
    if pressure_level not in UV_RANGES_MPS:
        raise ValueError(f"Unsupported pressure level for fixed ranges: {pressure_level}")

    umin, umax = UV_RANGES_MPS[pressure_level]
    vmin, vmax = UV_RANGES_MPS[pressure_level]

    r = scale_fixed_range(u_mean, umin, umax)
    g = scale_fixed_range(v_mean, vmin, vmax)
    b = np.zeros_like(r, dtype=np.uint8)
    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, g, b, a])
    image = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def uv850_to_hue_value_rgba(u: np.ndarray, v: np.ndarray,
                           vmax_mps: float = 60.0,
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


def _get_time_dim(da: xr.DataArray) -> str | None:
    if "time" in da.dims:
        return "time"
    if "valid_time" in da.dims:
        return "valid_time"
    return None


def main():
    pressureLevel = 850
    nc_path, out_png = resolve_paths()

    # ---- Performance knobs ----
    # Increase time_chunk for fewer tasks + more throughput, decrease if you hit RAM pressure.
    # On 16GB, 32–128 is usually reasonable (depends on grid size).
    TIME_CHUNK = 64

    ds = open_dataset(nc_path, time_chunk=TIME_CHUNK)

    # Prefer selecting only the needed variables (slightly less overhead)
    u_name = pick_var_name(ds, ["u", "u_component_of_wind", "u10", "u_component_of_wind_at_10m"])
    v_name = pick_var_name(ds, ["v", "v_component_of_wind", "v10", "v_component_of_wind_at_10m"])
    ds = ds[[u_name, v_name]]

    u_da = select_level_component(ds, u_name, pressureLevel)
    v_da = select_level_component(ds, v_name, pressureLevel)

    time_dim = _get_time_dim(u_da)
    if time_dim is None:
        u_mean = u_da.values.astype(np.float32)
        v_mean = v_da.values.astype(np.float32)
        n_times = 1
    else:
        # Ensure dask chunks along the correct time dimension
        # (If your file uses 'valid_time', we chunk that.)
        if time_dim != "time":
            u_da = u_da.chunk({time_dim: TIME_CHUNK})
            v_da = v_da.chunk({time_dim: TIME_CHUNK})

        # Dask-backed mean; compute() triggers parallelized execution.
        # skipna=True keeps behavior consistent with your streaming version.
        print("Computing dask mean for U...")
        u_mean_da = u_da.mean(dim=time_dim, skipna=True)
        print("Computing dask mean for V...")
        v_mean_da = v_da.mean(dim=time_dim, skipna=True)

        print("Computing dask mean for U...")
        with ProgressBar():
            u_mean = u_mean_da.compute().values.astype(np.float32, copy=False)

        print("Computing dask mean for V...")
        with ProgressBar():
            v_mean = v_mean_da.compute().values.astype(np.float32, copy=False)

        n_times = int(u_da.sizes.get(time_dim, 0))

    if u_mean.ndim != 2 or v_mean.ndim != 2:
        raise RuntimeError(f"Unexpected mean shapes: u={u_mean.shape}, v={v_mean.shape} (expected 2D)")

    png_bytes = encode_uv_avg_rgb_png(u_mean, v_mean, pressureLevel)
    with open(out_png, "wb") as f:
        f.write(png_bytes)

    print(f"\nWrote {out_png}")
    print(f"Times averaged: {n_times}")
    print(f"Mean U range: [{float(np.nanmin(u_mean)):.3f}, {float(np.nanmax(u_mean)):.3f}] m/s")
    print(f"Mean V range: [{float(np.nanmin(v_mean)):.3f}, {float(np.nanmax(v_mean)):.3f}] m/s")


if __name__ == "__main__":
    main()

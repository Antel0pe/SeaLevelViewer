import io
import os
import numpy as np
import xarray as xr
from PIL import Image
from dask.diagnostics import ProgressBar
from pathlib import Path
from dotenv import load_dotenv

def resolve_paths():
    load_dotenv()

    era5_raw_dir = Path(os.environ["ERA5_RAW_DIR"])
    downloads_dir = Path(os.environ["SEA_LEVEL_SCRIPTS_DIR"])

    in_nc = era5_raw_dir / "evap-precip-climatology.nc"
    out_png = downloads_dir / "era5_precip_test_color_scales.png"

    out_png.parent.mkdir(parents=True, exist_ok=True)
    return in_nc, out_png


def open_dataset(path: str, time_chunk: int = 64) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"NetCDF file not found: {path}")
    return xr.open_dataset(path, chunks={"time": time_chunk}, decode_times=False)


def pick_var_name(ds: xr.Dataset, candidates: list[str]) -> str:
    for c in candidates:
        if c in ds.variables:
            return c
    raise KeyError(
        f"None of these variables were found: {candidates}. Found: {list(ds.variables.keys())}"
    )


def _get_time_dim(da: xr.DataArray) -> str | None:
    if "time" in da.dims:
        return "time"
    if "valid_time" in da.dims:
        return "valid_time"
    return None


def _get_lat_name(da: xr.DataArray) -> str | None:
    for lat_name in ["latitude", "lat", "y"]:
        if lat_name in da.coords and da[lat_name].ndim == 1:
            return lat_name
    return None


def select_component(ds: xr.Dataset, var_name: str) -> xr.DataArray:
    if var_name not in ds.variables:
        raise KeyError(f"Variable '{var_name}' not found in dataset")

    da = ds[var_name]

    # If there are singleton dims (e.g., expver), drop them safely
    for d in list(da.dims):
        if da.sizes.get(d, 0) == 1:
            da = da.isel({d: 0})

    # Make sure latitude is ascending (south->north) for predictable flipping later
    lat_name = _get_lat_name(da)
    if lat_name is not None:
        latv = da[lat_name].values
        if np.any(np.diff(latv) < 0):
            da = da.sortby(lat_name)

    return da


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
    """
    Scale array to 0..255 using a power-law (gamma < 1 boosts low values).

    Parameters
    ----------
    a : np.ndarray
        Input array (assumed >= 0).
    vmax : float
        Reference maximum (e.g. 99th percentile).
    gamma : float
        Power-law exponent. <1 boosts inland / low values.
        Typical: 0.4–0.6
    """
    a = a.astype(np.float32, copy=False)
    out = np.zeros_like(a, dtype=np.uint8)

    if not np.isfinite(vmax) or vmax <= 0:
        return out

    # Normalize to [0, 1]
    scaled = np.clip(a / float(vmax), 0.0, 1.0)

    # Power-law (gamma) transform
    scaled = np.power(scaled, gamma)

    # Map to 8-bit
    out = (scaled * 255.0).astype(np.uint8)

    # Mask invalid input
    out[~np.isfinite(a)] = 0
    return out



def encode_evap_precip_png(evap_pos: np.ndarray, precip: np.ndarray, vmax: float) -> bytes:
    # Red = evaporation, Blue = precip, same scale

    r = scale_0_to_vmax_power(evap_pos, vmax)
    r = np.zeros_like(r, dtype=np.uint8)

    g = np.zeros_like(r, dtype=np.uint8)

    b = scale_0_to_vmax_power(precip, vmax)
    # b = np.zeros_like(r, dtype=np.uint8)

    a = np.full_like(r, 255, dtype=np.uint8)

    rgba = np.dstack([r, g, b, a])
    img = Image.fromarray(rgba, mode="RGBA")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.read()


def main():
    nc_path, out_png = resolve_paths()

    TIME_CHUNK = 64
    ds = open_dataset(nc_path, time_chunk=TIME_CHUNK)

    # Common ERA5 names:
    #   evaporation: "e" (typically negative for upward flux)
    #   precip:      "tp" (total precipitation)
    evap_name = pick_var_name(ds, ["e", "evap", "evaporation", "evspsbl"])
    precip_name = pick_var_name(ds, ["tp", "precip", "precipitation", "total_precipitation", "pr"])

    ds = ds[[evap_name, precip_name]]

    evap_da = select_component(ds, evap_name)
    precip_da = select_component(ds, precip_name)

    time_dim = _get_time_dim(evap_da)

    if time_dim is None:
        evap_mean = evap_da.values.astype(np.float32)
        precip_mean = precip_da.values.astype(np.float32)
        n_times = 1
    else:
        if time_dim != "time":
            evap_da = evap_da.chunk({time_dim: TIME_CHUNK})
            precip_da = precip_da.chunk({time_dim: TIME_CHUNK})

        print("Computing dask mean for evaporation...")
        evap_mean_da = evap_da.mean(dim=time_dim, skipna=True)

        print("Computing dask mean for precipitation...")
        precip_mean_da = precip_da.mean(dim=time_dim, skipna=True)

        with ProgressBar():
            evap_mean = evap_mean_da.compute().values.astype(np.float32, copy=False)
        with ProgressBar():
            precip_mean = precip_mean_da.compute().values.astype(np.float32, copy=False)

        n_times = int(evap_da.sizes.get(time_dim, 0))

    if evap_mean.ndim != 2 or precip_mean.ndim != 2:
        raise RuntimeError(
            f"Unexpected mean shapes: evap={evap_mean.shape}, precip={precip_mean.shape} (expected 2D)"
        )

    # ERA5 evaporation is often negative for evaporation (upward flux).
    evap_pos = (-1.0) * evap_mean

    # Sanity: clip tiny negatives to 0 so the color intensity means “amount”
    evap_pos = np.where(np.isfinite(evap_pos), np.maximum(evap_pos, 0.0), np.nan).astype(np.float32)
    precip_mean = np.where(np.isfinite(precip_mean), np.maximum(precip_mean, 0.0), np.nan).astype(np.float32)

    # Choose a shared scale [0 .. vmax] for both.
    # Robust: 99th percentile of the combined fields (after mean), so outliers don’t blow the map.
    combo = np.concatenate(
        [evap_pos[np.isfinite(evap_pos)].ravel(), precip_mean[np.isfinite(precip_mean)].ravel()]
    )
    if combo.size == 0:
        raise ValueError("No finite values found in evaporation/precipitation means.")

    vmax = float(np.nanpercentile(combo, 99))
    vmax = max(vmax, 1e-9)

    # Flip for PNG so north is at the top.
    # We sorted latitude to ascending (south->north), so flipud puts north on top.
    evap_pos = np.flipud(evap_pos)
    precip_mean = np.flipud(precip_mean)

    png_bytes = encode_evap_precip_png(evap_pos, precip_mean, vmax)
    with open(out_png, "wb") as f:
        f.write(png_bytes)

    print(f"\nWrote {out_png}")
    print(f"Times averaged: {n_times}")

    # Print min/max (post-processing, pre-scale), so you can sanity-check magnitudes.
    print(f"Evap mean (after *-1, clipped>=0) min/max: [{float(np.nanmin(evap_pos)):.6g}, {float(np.nanmax(evap_pos)):.6g}]")
    print(f"Precip mean (clipped>=0)         min/max: [{float(np.nanmin(precip_mean)):.6g}, {float(np.nanmax(precip_mean)):.6g}]")
    print(f"Shared color scale vmax (99th pct of both): {vmax:.6g}")
    print("Color mapping: Red=evaporation, Blue=precipitation (same 0..vmax scale).")


if __name__ == "__main__":
    main()

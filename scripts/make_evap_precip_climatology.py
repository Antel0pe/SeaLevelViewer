# Step 1/2: read evap+precip climatology NetCDF, time-average, and write a small mean NetCDF.
#
# Output file contains:
#   e_mean   : mean evaporation (original sign from source)
#   tp_mean  : mean total precipitation
#
# Notes:
# - We sort latitude to ascending (south->north) in the output file so downstream plotting is predictable.
# - We do NOT flip anything here. Flipping is a rendering concern, handled in the PNG script.

import os
import numpy as np
import xarray as xr
from dask.diagnostics import ProgressBar
from dotenv import load_dotenv
from pathlib import Path


def resolve_paths():
    load_dotenv()

    era5_raw_dir = Path(os.environ["ERA5_RAW_DIR"])

    in_nc = era5_raw_dir / "evap-precip-climatology.nc"
    out_mean_nc = era5_raw_dir / "evap-precip-climatology-mean.nc"

    out_mean_nc.parent.mkdir(parents=True, exist_ok=True)
    return in_nc, out_mean_nc


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

    # Drop singleton dims safely (e.g. expver)
    for d in list(da.dims):
        if da.sizes.get(d, 0) == 1:
            da = da.isel({d: 0})

    # Force latitude ascending (south->north) for consistent downstream behavior
    lat_name = _get_lat_name(da)
    if lat_name is not None:
        latv = da[lat_name].values
        if latv.size >= 2 and np.any(np.diff(latv) < 0):
            da = da.sortby(lat_name)  # ascending

    return da


def main():
    TIME_CHUNK = 64
    in_nc, out_mean_nc = resolve_paths()

    ds = open_dataset(in_nc, time_chunk=TIME_CHUNK)

    evap_name = pick_var_name(ds, ["e", "evap", "evaporation", "evspsbl"])
    precip_name = pick_var_name(ds, ["tp", "precip", "precipitation", "total_precipitation", "pr"])
    ds = ds[[evap_name, precip_name]]

    evap_da = select_component(ds, evap_name)
    precip_da = select_component(ds, precip_name)

    time_dim = _get_time_dim(evap_da)

    if time_dim is None:
        evap_mean = evap_da.astype(np.float32)
        precip_mean = precip_da.astype(np.float32)
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
            evap_mean = evap_mean_da.compute().astype(np.float32)

        with ProgressBar():
            precip_mean = precip_mean_da.compute().astype(np.float32)

        n_times = int(evap_da.sizes.get(time_dim, 0))

    if evap_mean.ndim != 2 or precip_mean.ndim != 2:
        raise RuntimeError(
            f"Unexpected mean shapes: evap={evap_mean.shape}, precip={precip_mean.shape} (expected 2D)"
        )

    out = xr.Dataset(
        data_vars={
            "e_mean": evap_mean,
            "tp_mean": precip_mean,
        }
    )

    out.attrs["times_averaged"] = int(n_times)
    out.attrs["source_file"] = os.path.abspath(in_nc)
    out.attrs["evap_source_var"] = str(evap_name)
    out.attrs["precip_source_var"] = str(precip_name)
    out.attrs["note_latitude_sorted"] = "latitude sorted ascending (south->north) if present"

    encoding = {
        "e_mean": {"zlib": True, "complevel": 4},
        "tp_mean": {"zlib": True, "complevel": 4},
    }

    out.to_netcdf(out_mean_nc, encoding=encoding)

    e_vals = out["e_mean"].values
    tp_vals = out["tp_mean"].values

    print(f"\nWrote mean file: {out_mean_nc}")
    print(f"Times averaged: {n_times}")
    print(f"E mean range:  [{float(np.nanmin(e_vals)):.6g}, {float(np.nanmax(e_vals)):.6g}] (source units)")
    print(f"TP mean range: [{float(np.nanmin(tp_vals)):.6g}, {float(np.nanmax(tp_vals)):.6g}] (source units)")


if __name__ == "__main__":
    main()

import os
import numpy as np
import xarray as xr
from dask.diagnostics import ProgressBar
from dotenv import load_dotenv
from pathlib import Path

UV_RANGES_MPS = {
    850: (-60.0, 60.0),
    500: (-80.0, 80.0),
    250: (-120.0, 120.0),
}


def resolve_paths():
    load_dotenv()

    era5_raw_dir = Path(os.environ["ERA5_RAW_DIR"])

    in_nc = era5_raw_dir / "uv-1981-2010-data.nc"
    out_mean_nc = era5_raw_dir / "uv-1981-2010-mean_850.nc"

    out_mean_nc.parent.mkdir(parents=True, exist_ok=True)

    return in_nc, out_mean_nc


def open_dataset(path: str, time_chunk: int = 64) -> xr.Dataset:
    if not os.path.exists(path):
        raise FileNotFoundError(f"ERA5 NetCDF file not found: {path}")
    return xr.open_dataset(path, chunks={"time": time_chunk}, decode_times=False)


def pick_var_name(ds: xr.Dataset, candidates: list[str]) -> str:
    for c in candidates:
        if c in ds.variables:
            return c
    raise KeyError(f"None of these variables were found: {candidates}. Found: {list(ds.variables.keys())}")


def _get_time_dim(da: xr.DataArray) -> str | None:
    if "time" in da.dims:
        return "time"
    if "valid_time" in da.dims:
        return "valid_time"
    return None


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

    # Keep latitude increasing (south->north) so output is consistent
    for lat_name in ["latitude", "lat"]:
        if lat_name in da.coords and da[lat_name].ndim == 1:
            latv = da[lat_name].values
            if np.any(np.diff(latv) < 0):
                da = da.sortby(lat_name)  # ascending
            break

    return da


def main():
    pressure_level = 850
    TIME_CHUNK = 64

    in_nc, out_mean_nc = resolve_paths()
    ds = open_dataset(in_nc, time_chunk=TIME_CHUNK)

    u_name = pick_var_name(ds, ["u", "u_component_of_wind", "u10", "u_component_of_wind_at_10m"])
    v_name = pick_var_name(ds, ["v", "v_component_of_wind", "v10", "v_component_of_wind_at_10m"])
    ds = ds[[u_name, v_name]]

    u_da = select_level_component(ds, u_name, pressure_level)
    v_da = select_level_component(ds, v_name, pressure_level)

    time_dim = _get_time_dim(u_da)
    if time_dim is None:
        # already 2D
        u_mean = u_da.astype(np.float32)
        v_mean = v_da.astype(np.float32)
        n_times = 1
    else:
        # make sure chunking is on the real time dimension
        if time_dim != "time":
            u_da = u_da.chunk({time_dim: TIME_CHUNK})
            v_da = v_da.chunk({time_dim: TIME_CHUNK})

        u_mean_da = u_da.mean(dim=time_dim, skipna=True)
        v_mean_da = v_da.mean(dim=time_dim, skipna=True)

        with ProgressBar():
            u_mean = u_mean_da.compute().astype(np.float32)
        with ProgressBar():
            v_mean = v_mean_da.compute().astype(np.float32)

        n_times = int(u_da.sizes.get(time_dim, 0))

    if u_mean.ndim != 2 or v_mean.ndim != 2:
        raise RuntimeError(f"Unexpected mean shapes: u={u_mean.shape}, v={v_mean.shape} (expected 2D)")

    out = xr.Dataset(
        data_vars={
            "u_mean": u_mean,
            "v_mean": v_mean,
        }
    )
    out.attrs["pressure_level_hpa"] = int(pressure_level)
    out.attrs["times_averaged"] = int(n_times)
    out.attrs["source_file"] = os.path.abspath(in_nc)

    # Compression (optional but nice)
    encoding = {
        "u_mean": {"zlib": True, "complevel": 4},
        "v_mean": {"zlib": True, "complevel": 4},
    }

    out.to_netcdf(out_mean_nc, encoding=encoding)

    print(f"Wrote mean file: {out_mean_nc}")
    print(f"Times averaged: {n_times}")
    print(f"U mean range: [{float(np.nanmin(out['u_mean'].values)):.3f}, {float(np.nanmax(out['u_mean'].values)):.3f}] m/s")
    print(f"V mean range: [{float(np.nanmin(out['v_mean'].values)):.3f}, {float(np.nanmax(out['v_mean'].values)):.3f}] m/s")


if __name__ == "__main__":
    main()

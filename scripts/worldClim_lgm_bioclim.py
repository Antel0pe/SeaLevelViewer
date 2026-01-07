"""
WorldClim LGM BIOCLIM (CCSM4) -> quick-look PNG exports

What it does
- Walks a folder containing:
    cclgmbi1.tif ... cclgmbi19.tif
- Writes 19 PNGs with readable titles.
- Uses:
    - Blue↔Red diverging for temperature-like BIO variables (°C), symmetric about 0°C.
    - Black↔White for precipitation-like BIO variables (mm), normalized by robust max.

Assumptions / knobs
- Some WorldClim temperature rasters are stored in *tenths of °C*.
  If your values look like -250..320 instead of -25..32, set TEMP_SCALE=0.1.
- Precip is typically mm. We display it as grayscale with a robust normalization.
- NoData values are read from the raster and converted to NaN.

pip install rasterio numpy matplotlib
"""

import os
from pathlib import Path
import numpy as np
import rasterio
import matplotlib.pyplot as plt

# ---------------- CONFIG ----------------
BIO_DIR = Path(r"/mnt/c/Users/dmmsp/Downloads/cclgmbi_10m")  # <-- change
OUT_DIR = Path("./bioclim_pngs")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# If the BIO temperature variables look 10x too large, use 0.1
TEMP_SCALE = 0.1  # <-- change to 1.0 if already in °C

# Plot sizing
FIGSIZE = (12, 6)
DPI = 200

# Robust display percentiles
TEMP_ABS_PCT = 99  # vmax = percentile(abs(temp), 99), symmetric about 0°C
PRECIP_PCT = 99    # vmax = percentile(precip, 99), then normalize 0..1

# ---------------------------------------

BIO_META = {
    1:  dict(name="Annual Mean Temperature", units="°C", kind="temp"),
    2:  dict(name="Mean Diurnal Range (Mean of monthly (max temp − min temp))", units="°C", kind="temp"),
    3:  dict(name="Isothermality (BIO2/BIO7 ×100)", units="%", kind="temp_index"),
    4:  dict(name="Temperature Seasonality (Std Dev ×100)", units="index", kind="temp_index"),
    5:  dict(name="Max Temperature of Warmest Month", units="°C", kind="temp"),
    6:  dict(name="Min Temperature of Coldest Month", units="°C", kind="temp"),
    7:  dict(name="Temperature Annual Range (BIO5 − BIO6)", units="°C", kind="temp"),
    8:  dict(name="Mean Temperature of Wettest Quarter", units="°C", kind="temp"),
    9:  dict(name="Mean Temperature of Driest Quarter", units="°C", kind="temp"),
    10: dict(name="Mean Temperature of Warmest Quarter", units="°C", kind="temp"),
    11: dict(name="Mean Temperature of Coldest Quarter", units="°C", kind="temp"),
    12: dict(name="Annual Precipitation", units="mm", kind="precip"),
    13: dict(name="Precipitation of Wettest Month", units="mm", kind="precip"),
    14: dict(name="Precipitation of Driest Month", units="mm", kind="precip"),
    15: dict(name="Precipitation Seasonality (Coefficient of Variation)", units="index", kind="precip_index"),
    16: dict(name="Precipitation of Wettest Quarter", units="mm", kind="precip"),
    17: dict(name="Precipitation of Driest Quarter", units="mm", kind="precip"),
    18: dict(name="Precipitation of Warmest Quarter", units="mm", kind="precip"),
    19: dict(name="Precipitation of Coldest Quarter", units="mm", kind="precip"),
}

# Which types we want to treat as temperature-like (blue-red) vs precip-like (grayscale)
TEMP_LIKE_KINDS = {"temp"}
PRECIP_LIKE_KINDS = {"precip"}

# For these index-ish variables, a grayscale is usually clearer (units not °C or mm)
INDEX_KINDS = {"temp_index", "precip_index"}


def read_tif_as_float(path: Path) -> np.ndarray:
    """Read band 1 as float32; map NoData to NaN."""
    with rasterio.open(path) as src:
        a = src.read(1).astype(np.float32)
        nodata = src.nodata
        if nodata is not None:
            a[a == nodata] = np.nan
    return a


def save_temp_diverging(temp_c: np.ndarray, out_png: Path, title: str):
    """
    Blue-red diverging map for temperature-like fields.
    Symmetric around 0°C so freezing line is visually meaningful.
    """
    valid = temp_c[np.isfinite(temp_c)]
    if valid.size == 0:
        raise ValueError(f"No valid temperature values to plot for {out_png.name}")

    vmax = float(np.nanpercentile(np.abs(valid), TEMP_ABS_PCT))
    vmax = max(vmax, 1.0)

    plt.figure(figsize=FIGSIZE, dpi=DPI)
    plt.imshow(temp_c, cmap="coolwarm", vmin=-vmax, vmax=vmax, interpolation="nearest")
    plt.title(title, fontsize=12)
    plt.axis("off")
    plt.tight_layout(rect=[0, 0, 1, 0.96])
    plt.savefig(out_png, bbox_inches="tight", pad_inches=0.05)
    plt.close()


def save_grayscale_robust(arr: np.ndarray, out_png: Path, title: str):
    """
    Black-white map for precip-like or index fields.
    Uses robust normalization: 0..P99 mapped to 0..1 (clips above).
    """
    valid = arr[np.isfinite(arr)]
    if valid.size == 0:
        raise ValueError(f"No valid values to plot for {out_png.name}")

    vmax = float(np.nanpercentile(valid, PRECIP_PCT))
    if vmax <= 0:
        # If everything is <=0 (rare for precip, possible for some indices),
        # fall back to absolute-based scaling.
        vmax = float(np.nanpercentile(np.abs(valid), PRECIP_PCT))
        vmax = max(vmax, 1e-6)

    arr01 = np.clip(arr / vmax, 0.0, 1.0)

    plt.figure(figsize=FIGSIZE, dpi=DPI)
    plt.imshow(arr01, cmap="gray", vmin=0.0, vmax=1.0, interpolation="nearest")
    plt.title(title, fontsize=12)
    plt.axis("off")
    plt.tight_layout(rect=[0, 0, 1, 0.96])
    plt.savefig(out_png, bbox_inches="tight", pad_inches=0.05)
    plt.close()


def main():
    missing = []
    for i in range(1, 20):
        tif = BIO_DIR / f"cclgmbi{i}.tif"
        if not tif.exists():
            missing.append(str(tif))
            continue

        meta = BIO_META[i]
        name = meta["name"]
        units = meta["units"]
        kind = meta["kind"]

        arr = read_tif_as_float(tif)

        # Apply TEMP_SCALE only for true temperature-unit variables (°C)
        if kind in TEMP_LIKE_KINDS:
            arr = arr * TEMP_SCALE

        title = f"LGM CCSM4 — BIO{i}: {name} ({units})"
        out_png = OUT_DIR / f"lgm_bio{i:02d}.png"

        # Choose rendering style
        if kind in TEMP_LIKE_KINDS:
            save_temp_diverging(arr, out_png, title=title)
        else:
            # precip + index -> grayscale
            save_grayscale_robust(arr, out_png, title=title)

        vmin = float(np.nanmin(arr)) if np.isfinite(arr).any() else float("nan")
        vmax = float(np.nanmax(arr)) if np.isfinite(arr).any() else float("nan")
        print(f"Saved {out_png.name}  |  data min/max: {vmin:.3f} .. {vmax:.3f}")

    if missing:
        print("\nMissing files:")
        for m in missing:
            print("  ", m)
        raise SystemExit("Some BIO files were missing; see list above.")

    print(f"\nDone. PNGs in: {OUT_DIR.resolve()}")


if __name__ == "__main__":
    main()

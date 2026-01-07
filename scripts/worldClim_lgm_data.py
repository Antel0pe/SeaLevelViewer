# WorldClim LGM: sum precip + average temps, then export PNGs
#
# Assumes:
#   precip: cclgmpr1.tif ... cclgmpr12.tif  (mm/month)  -> annual sum
#   tn:     cclgmtn1.tif ... cclgmtn12.tif  (°C*10?) or (°C) -> annual mean + max of monthly mins
#   tx:     cclgmtx1.tif ... cclgmtx12.tif  (°C*10?) or (°C) -> annual mean + max of monthly maxes
#
# If tn/tx look like they're in tenths of °C (common for WorldClim), set TEMP_SCALE = 0.1.
# Your rasterio src.scales is 1.0 for pr; tn/tx may still be stored scaled even if metadata doesn't say.
#
# pip install rasterio matplotlib numpy

import os
import numpy as np
import rasterio
import matplotlib.pyplot as plt

# ---------------- CONFIG ----------------
base = r"/mnt/c/Users/dmmsp/Downloads"

pr_dir = os.path.join(base, "cclgmpr_10m")
tn_dir = os.path.join(base, "cclgmtn_10m")
tx_dir = os.path.join(base, "cclgmtx_10m")

months = range(1, 13)

pr_pattern = "cclgmpr{m}.tif"
tn_pattern = "cclgmtn{m}.tif"
tx_pattern = "cclgmtx{m}.tif"

# If your temp files have values like -250 or 320 that "look" like tenths of °C,
# set to 0.1. If values already look like -25.0..32.0, keep 1.0.
TEMP_SCALE = 0.1  # <-- change to 1.0 if already in °C

out_pr_png = "./worldClimImages/lgm_precip_annual_sum_normalized.png"

out_tn_png = "./worldClimImages/lgm_tn_annual_mean_and_warmest_night.png"
# = mean TN over year + max(TN) (warmest month nights)

out_tx_png = "./worldClimImages/lgm_tx_annual_mean_and_warmest_day.png"
# = mean TX over year + max(TX) (warmest month days)

# ---------------------------------------


def read_stack(folder: str, pattern: str, months_range) -> tuple[np.ndarray, float]:
    """Read 12 monthly rasters into a (12, H, W) float32 stack, masking NoData to NaN."""
    stack = []
    nodata = None

    for m in months_range:
        path = os.path.join(folder, pattern.format(m=m))
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing file: {path}")

        with rasterio.open(path) as src:
            if nodata is None:
                nodata = src.nodata

            a = src.read(1).astype(np.float32)
            if nodata is not None:
                a[a == nodata] = np.nan
            stack.append(a)

    return np.stack(stack, axis=0), nodata


def save_grayscale01(arr01: np.ndarray, out_png: str, title: str | None = None):
    arr01 = np.clip(arr01, 0.0, 1.0)
    plt.figure(figsize=(12, 6), dpi=200)
    plt.imshow(arr01, cmap="gray", vmin=0.0, vmax=1.0, interpolation="nearest")
    if title:
        plt.title(title)
    plt.axis("off")
    plt.tight_layout(pad=0)
    plt.savefig(out_png, bbox_inches="tight", pad_inches=0)
    plt.close()


def save_temp_diverging(temp_c: np.ndarray, out_png: str, title: str):
    """
    Save a blue-red diverging map for temperature (°C).
    Uses a symmetric range around 0°C so freezing line is visually meaningful.
    """
    valid = temp_c[np.isfinite(temp_c)]
    if valid.size == 0:
        raise ValueError("No valid temperature values to plot.")

    vmax = float(np.nanpercentile(np.abs(valid), 99))
    vmax = max(vmax, 1.0)

    plt.figure(figsize=(12, 6), dpi=200)
    plt.imshow(
        temp_c,
        cmap="coolwarm",
        vmin=-vmax,
        vmax=vmax,
        interpolation="nearest",
    )
    plt.title(title, fontsize=12)
    plt.axis("off")
    plt.tight_layout(rect=[0, 0, 1, 0.96])  # leave room for title
    plt.savefig(out_png, bbox_inches="tight", pad_inches=0.05)
    plt.close()


# ----------------- PRECIP (annual sum) -----------------
pr_stack, _ = read_stack(pr_dir, pr_pattern, months)
pr_annual = np.nansum(pr_stack, axis=0)  # mm/year (since mm/month summed)

# For display: treat NaN as 0 precip
pr_display = np.nan_to_num(pr_annual, nan=0.0)
pr_max = float(np.max(pr_display))
if pr_max <= 0:
    raise ValueError("Max precip is <= 0; check rasters.")
pr_norm = pr_display / pr_max

save_grayscale01(pr_norm, out_pr_png, title=None)
print(f"Saved: {out_pr_png}")
print(f"Precip annual-sum max (raw units): {pr_max}")

# ----------------- TN (mean + max of monthly mins) -----------------
tn_stack, _ = read_stack(tn_dir, tn_pattern, months)
tn_stack *= TEMP_SCALE

tn_mean = np.nanmean(tn_stack, axis=0)         # average of the 12 monthly tn fields
tn_max_of_mins = np.nanmax(tn_stack, axis=0)   # highest "minimum temp" across months (warmest tn)

print("TN mean (C) min/max:", float(np.nanmin(tn_mean)), float(np.nanmax(tn_mean)))
print("TN max-of-mins (C) min/max:", float(np.nanmin(tn_max_of_mins)), float(np.nanmax(tn_max_of_mins)))

# Save a diverging plot of the mean TN (blue=cold, red=warm)
save_temp_diverging(tn_mean, out_tn_png, title="LGM CCSM4: TN mean (°C)")
print(f"Saved: {out_tn_png}")

# ----------------- TX (mean + max of monthly maxes) -----------------
tx_stack, _ = read_stack(tx_dir, tx_pattern, months)
tx_stack *= TEMP_SCALE

tx_mean = np.nanmean(tx_stack, axis=0)         # average of the 12 monthly tx fields
tx_max_of_maxes = np.nanmax(tx_stack, axis=0)  # highest "maximum temp" across months (warmest tx)

print("TX mean (C) min/max:", float(np.nanmin(tx_mean)), float(np.nanmax(tx_mean)))
print("TX max-of-maxes (C) min/max:", float(np.nanmin(tx_max_of_maxes)), float(np.nanmax(tx_max_of_maxes)))

save_temp_diverging(tx_mean, out_tx_png, title="LGM CCSM4: TX mean (°C)")
print(f"Saved: {out_tx_png}")

# ---- Seasonal extreme maps (per-pixel, across the 12 months) ----
# tn_stack, tx_stack are shape (12, H, W) in °C (after TEMP_SCALE)

# mask for pixels that are NaN in all months (prevents warnings + gives clean NaNs)
tn_allnan = np.all(np.isnan(tn_stack), axis=0)
tx_allnan = np.all(np.isnan(tx_stack), axis=0)

# Coldest/warmest month for TN (cold-side temps)
with np.errstate(invalid="ignore"):
    tn_coldest_month = np.nanmin(tn_stack, axis=0)   # winter-peak severity proxy
    tn_warmest_month = np.nanmax(tn_stack, axis=0)   # warmest nights proxy

tn_coldest_month[tn_allnan] = np.nan
tn_warmest_month[tn_allnan] = np.nan

# Coldest/warmest month for TX (warm-side temps)
with np.errstate(invalid="ignore"):
    tx_coldest_month = np.nanmin(tx_stack, axis=0)   # coldest days proxy
    tx_warmest_month = np.nanmax(tx_stack, axis=0)   # summer-peak heat proxy

tx_coldest_month[tx_allnan] = np.nan
tx_warmest_month[tx_allnan] = np.nan

# Output PNGs (blue=cold, red=warm)
# Night-time (TN) extremes
save_temp_diverging(
    tn_coldest_month,
    "./worldClimImages/lgm_tn_coldest_month_night.png",
    title="LGM CCSM4 — Coldest Month (TN, mean nightly minimum, °C)",
)

save_temp_diverging(
    tn_warmest_month,
    "./worldClimImages/lgm_tn_warmest_month_night.png",
    title="LGM CCSM4 — Warmest Month (TN, mean nightly minimum, °C)",
)

# Day-time (TX) extremes
save_temp_diverging(
    tx_coldest_month,
    "./worldClimImages/lgm_tx_coldest_month_day.png",
    title="LGM CCSM4 — Coldest Month (TX, mean daily maximum, °C)",
)

save_temp_diverging(
    tx_warmest_month,
    "./worldClimImages/lgm_tx_warmest_month_day.png",
    title="LGM CCSM4 — Warmest Month (TX, mean daily maximum, °C)",
)

print("Done.")

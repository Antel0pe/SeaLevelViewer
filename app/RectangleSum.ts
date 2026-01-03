import { tileRowToLat } from "./utils";

export type WindowSpec = {
  // Inclusive offsets relative to the current pixel (x,y)
  // Example centered box: dx0=-r, dx1=+r, dy0=-r, dy1=+r
  dx0: number; dx1: number;
  dy0: number; dy1: number;
};

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function satIndex(x: number, y: number, w: number) {
  return y * (w + 1) + x;
}

/**
 * Build SAT where each cell stores “sum of everything up-left of here”.
 * sat is (w+1)*(h+1). sat(0,*) and sat(*,0) are 0.
 */
export function buildSAT(src: Float32Array, w: number, h: number): Float32Array {
  const sat = new Float32Array((w + 1) * (h + 1));

  for (let y = 1; y <= h; y++) {
    // running sum along this src row
    let rowSum = 0;
    const srcRow = (y - 1) * w;

    for (let x = 1; x <= w; x++) {
      rowSum += src[srcRow + (x - 1)];
      // sat(x,y) = sat(x, y-1) + rowSum
      sat[satIndex(x, y, w)] = sat[satIndex(x, y - 1, w)] + rowSum;
    }
  }

  return sat;
}

/**
 * Rectangle sum in src coordinates (inclusive):
 * x in [x0..x1], y in [y0..y1]
 *
 * Uses the “4 corners” inclusion/exclusion trick on the SAT.
 */
export function rectSumSAT(
  sat: Float32Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const ax0 = x0;
  const ay0 = y0;
  const ax1 = x1 + 1;
  const ay1 = y1 + 1;

  const D = sat[satIndex(ax1, ay1, w)];
  const C = sat[satIndex(ax0, ay1, w)];
  const B = sat[satIndex(ax1, ay0, w)];
  const A = sat[satIndex(ax0, ay0, w)];

  return D - C - B + A;
}

/**
 * Given a SAT + rectangle bounds, return the average in that rectangle.
 * (average = sum / area)
 */
export function rectAvgFromSAT(
  sat: Float32Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const sum = rectSumSAT(sat, w, x0, y0, x1, y1);
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  return sum / area;
}

function modWrap(x: number, m: number) {
  const r = x % m;
  return r < 0 ? r + m : r;
}

/**
 * Average over a rectangle window where X wraps (longitude),
 * Y does NOT wrap (latitude) — we clamp Y.
 * in case we have a wrapping we break it into 2 rectangles the part before and after the wrapping then average those together
 */
export function rectAvgFromSAT_WrapX(
  sat: Float32Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  // (Optional but recommended) safety swaps:
  if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }

  const a0 = modWrap(x0, w);
  const a1 = modWrap(x1, w);

  if (a0 <= a1) {
    const sum = rectSumSAT(sat, w, a0, y0, a1, y1);
    const area = (y1 - y0 + 1) * (a1 - a0 + 1);
    return sum / area;
  } else {
    const sum1 = rectSumSAT(sat, w, a0, y0, w - 1, y1);
    const sum2 = rectSumSAT(sat, w, 0,  y0, a1,   y1);
    const area1 = (y1 - y0 + 1) * (w - a0);
    const area2 = (y1 - y0 + 1) * (a1 + 1);
    return (sum1 + sum2) / (area1 + area2);
  }
}



/**
 * This is “the blur”.
 *
 * Your understanding:
 * - Convert mask (U8) to 0/1 floats so averaging makes sense.
 * - For each pass:
 *   - build SAT once (precomputes up-left sums for the whole image)
 *   - for each pixel:
 *     - decide which rectangle window you want relative to the pixel
 *     - clamp rectangle to map bounds
 *     - use SAT (4 reads) to get the sum instantly
 *     - divide by area to get the average (0..1)
 * - Optionally repeat passes to make it smoother.
 *
 * getWindowForRow:
 * - lets you vary the rectangle by latitude band (row)
 * - e.g. centered near poles, SW-biased mid-lats, west-biased tropics, etc.
 */
export function blurMaskWithSAT_U8(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  passes: number,
  getWindowForRow: (y: number, h: number, r: number) => WindowSpec
): Float32Array {
  const r = Math.max(0, radius | 0);
  const pCount = Math.max(1, passes | 0);

  if (r === 0) return src;

  let cur: Float32Array = src.slice();     
  let dst: Float32Array = new Float32Array(w * h);

  for (let pass = 0; pass < pCount; pass++) {
    // 2) Precompute the SAT for the current src field
    const sat = buildSAT(src, w, h);

    // 3) For every pixel, average over the chosen rectangle window
    for (let y = 0; y < h; y++) {
      const win = getWindowForRow(y, h, r);

      for (let x = 0; x < w; x++) {
        // Window bounds in src coords (inclusive)
        let x0 = x + win.dx0;
        let x1 = x + win.dx1;
        let y0 = y + win.dy0;
        let y1 = y + win.dy1;

        // If someone gives reversed bounds, just fix it
        if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
        if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }

        // we allow x to wrap around, but not y. we care more about longitude wrapping than latitude for now
        // if this changes we change this and the rectAvgFromSAT_WrapX func
        y0 = clamp(y0, 0, h - 1);
        y1 = clamp(y1, 0, h - 1);

        // Average over that rectangle using SAT (fast, constant-time)
        // dst[y * w + x] = rectAvgFromSAT(sat, w, x0, y0, x1, y1);
        dst[y * w + x] = rectAvgFromSAT_WrapX(sat, w, x0, y0, x1, y1);
      }
    }

    if (pass < pCount - 1) {
      const tmp = cur;
      cur = dst;
      dst = tmp;
    }
  }

  // dst is already in [0..1] because it’s an average of 0/1 values
  return cur;
}

function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// 0 at a<=a0, 1 at a>=a1, smooth in between
function smoothstep(a0: number, a1: number, a: number) {
  const t = clamp01((a - a0) / (a1 - a0));
  return t * t * (3 - 2 * t);
}

// Linear interpolation
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Latitude-anchored rectangular window.
 *
 * latDeg: + in Northern Hemisphere, - in Southern.
 * r: your base radius.
 *
 * Behavior:
 * - |lat| small -> pixel is center-left of a wide box (equator)
 * - NH mid -> pixel top-right of box
 * - SH mid -> pixel bottom-right of box
 * - near poles -> centered box
 *
 * TODO: currently radius does not vary with latitude. not big deal for visual realism but exists
 */
export function windowByLatitudeAnchors(latDeg: number, r: number): WindowSpec {
  const a = Math.abs(latDeg);

  // Tunable latitude boundaries (in degrees)
  const EQUATOR_FULL = 10;  // fully "equator center-left" up to here
  const MID_START    = 25;  // start transitioning into mid-lat cornering
  const MID_FULL     = 55;  // fully mid-lat behavior by here
  const POLE_START   = 70;  // start transitioning to centered
  const POLE_FULL    = 85;  // fully centered by here

  // How much we're in equator regime (1 near equator, 0 by mid-lats)
  const equatorT = 1 - smoothstep(EQUATOR_FULL, MID_START, a);

  // How much we're in mid-lat regime (0 near equator, 1 through mid-lats, then fades at poles)
  const midRise  = smoothstep(MID_START, MID_FULL, a);
  const midFall  = 1 - smoothstep(POLE_START, POLE_FULL, a);
  const midT = midRise * midFall;

  // How much we're in pole regime (0 until POLE_START, 1 near poles)
  const poleT = smoothstep(POLE_START, POLE_FULL, a);

  // Define the three “pure” windows (as offsets):
  // 1) Equator: pixel = center-left of a 2r+1 tall, 2r+1 wide? Actually wide is 2r+1 if centered.
  // You asked center-left: make it extend 2r to the right, and r up/down.
  const eq = { dx0: -2*r,    dx1: 0, dy0: -r,    dy1: +r };

  // 2) Mid-lat NH: pixel = top-right => extends left and down
  const nh = { dx0: -2*r, dx1: 0,      dy0: 0,     dy1: +2 * r };

  // 3) Mid-lat SH: pixel = bottom-right => extends left and up
  const sh = { dx0: -2*r, dx1: 0,      dy0: -2*r, dy1: 0 };

  // 4) Poles: centered
  const pole = { dx0: -r,  dx1: +r,    dy0: -r,   dy1: +r };

  // Start from 0 and blend contributions.
  // We blend eq + mid (NH/SH) + pole with weights equatorT, midT, poleT.
  // They’re designed so weights sum ~1 across latitudes.
  const mid = latDeg >= 0 ? nh : sh;

  const wEq = equatorT;
  const wMid = midT;
  const wPole = poleT;

  const dx0 = Math.round(wEq * eq.dx0 + wMid * mid.dx0 + wPole * pole.dx0);
  const dx1 = Math.round(wEq * eq.dx1 + wMid * mid.dx1 + wPole * pole.dx1);
  const dy0 = Math.round(wEq * eq.dy0 + wMid * mid.dy0 + wPole * pole.dy0);
  const dy1 = Math.round(wEq * eq.dy1 + wMid * mid.dy1 + wPole * pole.dy1);

  return { dx0, dx1, dy0, dy1 };
}

export function makeGetWindowForRow(
  map: L.Map,
  coords: L.Coords
): (y: number, h: number, r: number) => WindowSpec {
  return (y, h, r) => {
    const latDeg = tileRowToLat(map, coords, y, h); // your existing function
    return windowByLatitudeAnchors(latDeg, r);
  };
}

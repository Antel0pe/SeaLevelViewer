import L from "leaflet";

export function boxBlurMaskU8(
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number,
  passes: number = 1
): Float32Array {
  // radius r = how far left/right/up/down we look
  // passes = how many times we repeat the blur to make it smoother
  const r = Math.max(0, radius | 0);
  const pCount = Math.max(1, passes | 0);

  // Convert the Uint8Array land/water mask into floats 0 or 1
  // (this lets averaging make sense)
  let src = new Float32Array(w * h);
  for (let i = 0; i < src.length; i++) {
    src[i] = mask[i] ? 1 : 0;
  }

  // If radius is 0, no blur — each pixel just stays itself
  if (r === 0) return src;

  let tmp = new Float32Array(w * h);
  let dst = new Float32Array(w * h);

  // Repeat the blur multiple times if passes > 1
  for (let p = 0; p < pCount; p++) {

    // --------------------
    // HORIZONTAL BLUR
    // --------------------
    // We blur each row independently, left → right
    // This handles the "x direction" of the box blur

    // We are averaging (2r + 1) values, so multiply by this instead of dividing
    const inv = 1 / (2 * r + 1);

    for (let y = 0; y < h; y++) {
      const row = y * w;

      // Compute the sum for x = 0 explicitly
      // This corresponds to the window [-r .. +r] around x=0
      // Values outside the map get clamped, so the edge pixel repeats
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const xk = clamp(k, 0, w - 1);
        sum += src[row + xk];
      }

      // Average = sum / windowSize
      tmp[row + 0] = sum * inv;

      // Now slide the window across the row
      // Instead of recomputing the whole sum each time:
      //  - subtract the pixel leaving the window
      //  - add the pixel entering the window
      for (let x = 1; x < w; x++) {
        // Pixel that just left the window (far left)
        const xOut = clamp(x - r - 1, 0, w - 1);

        // Pixel that just entered the window (far right)
        const xIn = clamp(x + r, 0, w - 1);

        // Update rolling sum
        sum += src[row + xIn] - src[row + xOut];

        // Store the averaged value at this pixel
        tmp[row + x] = sum * inv;
      }
    }

    // --------------------
    // VERTICAL BLUR
    // --------------------
    // Same idea as horizontal, but now we go top → bottom
    // This completes the 2D box blur (square window)

    for (let x = 0; x < w; x++) {

      // Initial sum for y = 0 (window [-r .. +r] vertically)
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const yk = clamp(k, 0, h - 1);
        sum += tmp[yk * w + x];
      }

      dst[0 * w + x] = sum * inv;

      // Slide the vertical window downward
      for (let y = 1; y < h; y++) {
        const yOut = clamp(y - r - 1, 0, h - 1);
        const yIn = clamp(y + r, 0, h - 1);

        sum += tmp[yIn * w + x] - tmp[yOut * w + x];
        dst[y * w + x] = sum * inv;
      }
    }

    // If we’re doing multiple passes, the output becomes the input
    if (p < pCount - 1) {
      const swap = src;
      src = dst;
      dst = swap;
    }
  }

  for (let p = 0; p < w * h; p++) {
    dst[p] /= 255;
  }

  // Final blurred result:
  // each pixel is now "fraction of nearby pixels (within radius r) that were 1"
  return dst;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function tileRowToLat(
    map: L.Map,
    coords: L.Coords,
    py: number,
    tileHeight: number
): number {
    const globalY = coords.y * tileHeight + py;
    return map.unproject(L.point(0, globalY), coords.z).lat;
}
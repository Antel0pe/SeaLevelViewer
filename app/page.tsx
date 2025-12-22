"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type RecolorLayer = L.GridLayer & {
  setThreshold?: (t: number) => void;
};

export default function Home() {
  const [threshold, setThreshold] = useState(120);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<RecolorLayer | null>(null);

  // Small helper: linear interpolate between two colors
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  // Color ramps (simple, tweak later)
  // Water: darker blue at deep, lighter near shore
  const waterColor = (v: number, thr: number) => {
    const t = thr > 0 ? Math.max(0, Math.min(1, v / thr)) : 0;
    const r = lerp(5, 70, t);
    const g = lerp(40, 140, t);
    const b = lerp(120, 220, t);
    return [r, g, b] as const;
  };

  // Land: green at low elevations -> brown at high elevations
  const landColor = (v: number) => {
    // v in [thr..255] but we don't pass thr here; just map 0..255 for simplicity
    const t = Math.max(0, Math.min(1, v / 255));
    const r = lerp(35, 160, t);
    const g = lerp(120, 110, t);
    const b = lerp(40, 60, t);
    return [r, g, b] as const;
  };

  const createRecolorLayer = useMemo(() => {
    // We capture functions above via closure; threshold is set dynamically via setThreshold
    let currentThreshold = threshold;

    const layer: RecolorLayer = L.gridLayer({
      tileSize: 256,
      minZoom: 0,
      maxZoom: 3,
      noWrap: false,
      tms: true,
      updateWhenIdle: true,
      keepBuffer: 2,
    }) as RecolorLayer;

    layer.setThreshold = (t: number) => {
      currentThreshold = t;
      // Redraw tiles
      layer.redraw();
    };

    layer.createTile = function (coords: L.Coords) {
      const tile = document.createElement("canvas");

      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;

      const ctx = tile.getContext("2d", { willReadFrequently: true });
      if (!ctx) return tile;

      const img = new Image();
      img.crossOrigin = "anonymous"; // safe even for same-origin

      const z = coords.z;
      const x = coords.x;
      const y = coords.y;

      // Flip XYZ -> TMS
      const tmsY = (1 << z) - 1 - y;

      img.src = `/tiles/${z}/${x}/${tmsY}.png`;

      img.onload = () => {
        ctx.drawImage(img, 0, 0, size.x, size.y);
        const imageData = ctx.getImageData(0, 0, size.x, size.y);
        const data = imageData.data;

        const thr = currentThreshold;

        for (let i = 0; i < data.length; i += 4) {
          // Your tiles are grayscale PNGs: R=G=B=value
          const v = data[i];

          // Optional: if you reserved 255 as nodata, you can make it transparent:
          // if (v === 255) { data[i+3] = 0; continue; }

          let r: number, g: number, b: number;

          if (v < thr) {
            [r, g, b] = waterColor(v, thr);
          } else {
            [r, g, b] = landColor(v);
          }

          data[i] = r | 0;
          data[i + 1] = g | 0;
          data[i + 2] = b | 0;
          data[i + 3] = 255;
        }

        ctx.putImageData(imageData, 0, 0);
      };

      // If a tile 404s at higher zoom edges, just leave it blank
      img.onerror = () => {
        ctx.clearRect(0, 0, size.x, size.y);
      };

      return tile;
    };

    return layer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // create once

  useEffect(() => {
    const map = L.map("map", {
      center: [20, 0],
      zoom: 1,
      minZoom: 0,
      maxZoom: 3,
      worldCopyJump: true,
    });


    mapRef.current = map;

    // Add recolor layer (instead of raw grayscale tile layer)
    createRecolorLayer.addTo(map);
    layerRef.current = createRecolorLayer;

    // Set initial threshold
    layerRef.current.setThreshold?.(threshold);

    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [createRecolorLayer]);

  useEffect(() => {
    // Update layer threshold when slider changes
    layerRef.current?.setThreshold?.(threshold);
  }, [threshold]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-50 dark:bg-black">
      {/* Map */}
      <div className="h-full w-[80%]">
        <div id="map" className="h-full w-full" />
      </div>

      {/* Sidebar */}
      <div className="h-full w-[20%] border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 flex flex-col gap-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Controls
        </h2>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-700 dark:text-zinc-300">
              Water level
            </label>
            <div className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
              {threshold}
            </div>
          </div>

          <input
            type="range"
            min={0}
            max={255}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            className="w-full"
          />

          <div className="text-xs text-zinc-500 dark:text-zinc-500">
            Note: this threshold is in your 0–255 tile values (not meters yet).
          </div>
        </div>
      </div>
    </div>
  );
}

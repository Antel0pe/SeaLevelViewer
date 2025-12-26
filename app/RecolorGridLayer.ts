// RecolorGridLayer.ts
import L from "leaflet";
import { boxBlurMaskU8, tileRowToLat } from "./utils";
import { blurMaskWithSAT_U8, makeGetWindowForRow } from "./RectangleSum";

type TileRecord = {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    originalData: Uint8ClampedArray;
    coords: L.Coords;
};

type ColorContext = {
    inputs: {
        originalData: Uint8ClampedArray;
        width: number;
        height: number;
        coords: L.Coords;
    };
    params: RecolorParams
    derived: {
        isLandMask: Uint8Array;          // 0 sea, 1 land
        heightAboveSea: Uint8Array;      // 0 for sea, else (elev - seaLevel)
        iceMask: Uint8Array;
        effectiveSeaLevel: number;
        moistureAvailability: Float32Array;
        sstByLatitude: Float32Array;
    };
};

export type RecolorParams = {
    seaLevel: number;
    iceLevel: number;

    latitudeBiasExponent: number;
    elevationOfIce: number;
    seaBias: number;
    landBias: number;
    elevationModifier: number;

    seaLevelDropDueToIce: number;

    dryingOutExponent: number;
};

export type RecolorLayer = L.GridLayer & {
    setParams(p: Partial<RecolorParams>): void;
};

export type CanvasLayerCtor = new (opts?: L.GridLayerOptions) => RecolorLayer;

export type CreateRecolorLayerOpts = {
    getMap: () => L.Map | null;              // instead of mapRef
    tileUrl: (coords: L.Coords) => string;   // lets you swap sources easily
    initial: RecolorParams
};

export function createRecolorLayer(opts: CreateRecolorLayerOpts): RecolorLayer {
    const {
        getMap,
        tileUrl,
        initial = {},
    } = opts;




    const lerp = (a: number, b: number, threshold: number) =>
        a + (b - a) * threshold;

    // --------------------
    // WATER COLOR RAMP
    // --------------------
    // Deep water (value = 0)
    const DEEP_WATER = [5, 40, 120] as const;

    // Shallow water / shoreline (value = seaLevel)
    const SHALLOW_WATER = [70, 140, 220] as const;

    const waterColor = (value: number, seaLevel: number) => {
        const threshold =
            seaLevel > 0
                ? Math.max(0, Math.min(1, value / seaLevel))
                : 0;

        const r = lerp(DEEP_WATER[0], SHALLOW_WATER[0], threshold);
        const g = lerp(DEEP_WATER[1], SHALLOW_WATER[1], threshold);
        const b = lerp(DEEP_WATER[2], SHALLOW_WATER[2], threshold);

        return [r, g, b] as const;
    };

    // --------------------
    // LAND COLOR RAMP
    // --------------------
    // Low elevation land (plains / vegetation)
    const LOW_LAND = [35, 120, 40] as const;

    // High elevation land (mountains / rock)
    const HIGH_LAND = [160, 110, 60] as const;

    const landColor = (value: number) => {
        // value assumed in [0..255]
        const threshold = Math.max(0, Math.min(1, value / 255));

        const r = lerp(LOW_LAND[0], HIGH_LAND[0], threshold);
        const g = lerp(LOW_LAND[1], HIGH_LAND[1], threshold);
        const b = lerp(LOW_LAND[2], HIGH_LAND[2], threshold);

        return [r, g, b] as const;
    };

    // --------------------
    // ICE COLOR
    // --------------------
    // Ice is just solid white wherever it exists (value = 1)
    const ICE = [255, 255, 255] as const;

    const iceColor = () => {
        return ICE;
    };

    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

    let CanvasLayer = L.GridLayer.extend({
        _tileStore: new WeakMap<HTMLCanvasElement, TileRecord>(),
        params: initial as RecolorParams,

        buildColorContext: function (
            originalData: Uint8ClampedArray,
            width: number,
            height: number,
            coords: L.Coords
        ): ColorContext {
            const isLandMask = new Uint8Array(width * height);

            return {
                inputs: {
                    originalData,
                    width,
                    height,
                    coords,
                },
                params: this.params,
                derived: {
                    isLandMask,
                    heightAboveSea: new Uint8Array(width * height),
                    iceMask: new Uint8Array(width * height),
                    effectiveSeaLevel: this.params.seaLevel,
                    moistureAvailability: new Float32Array(width * height),
                    sstByLatitude: new Float32Array(width * height),
                },
            };
        },

        deriveEffectiveSeaLevel: function (ctx: ColorContext) {
            const { seaLevel, iceLevel, seaLevelDropDueToIce } = ctx.params; // iceLevel: 0..1

            const seaDrop = iceLevel * seaLevel * seaLevelDropDueToIce;

            // Clamp to [0, 255] so downstream logic stays sane
            let eff = seaLevel - seaDrop;
            if (eff < 0) eff = 0;
            if (eff > 255) eff = 255;

            ctx.derived.effectiveSeaLevel = eff;
        },

        colorPixelsBySeaLevel: function (ctx: ColorContext) {
            const { originalData, height, coords, width } = ctx.inputs;
            // const { seaLevel } = ctx.params;
            const { isLandMask, heightAboveSea, effectiveSeaLevel } = ctx.derived;

            for (let i = 0, p = 0; i < originalData.length; i += 4, p++) {
                const elevation = originalData[i];

                if (elevation < effectiveSeaLevel) {
                    isLandMask[p] = 0;
                    heightAboveSea[p] = 0;
                } else {
                    isLandMask[p] = 1;

                    // clamp because Uint8Array wraps on >255
                    const h = elevation - effectiveSeaLevel;
                    heightAboveSea[p] = h > 255 ? 255 : h < 0 ? 0 : h;
                }
            }

            const map = getMap();
            if (!map) return;
            const latByRow = new Float32Array(height);
            for (let py = 0; py < height; py++) {
                latByRow[py] = tileRowToLat(map, coords, py, height);
            }

            const MAX_SST = 29.5;  // equatorial warm ocean
            const MIN_SST = -1.8;  // freezing seawater
            const INV_RANGE = 1 / (MAX_SST - MIN_SST);

            for (let y = 0; y < height; y++) {
                const latDeg = latByRow[y];
                const latRad = (Math.abs(latDeg) * Math.PI) / 180;

                // Same latitude → SST shape as before
                const t = Math.pow(Math.cos(latRad), 1.6); // 1 at equator → 0 at poles
                let sst = MIN_SST + (MAX_SST - MIN_SST) * t;

                // subtle NH cooling asymmetry (optional but nice visually)
                if (latDeg > 0) {
                    sst -= 0.8 * Math.pow(Math.sin(latRad), 1.2);
                }

                // Normalize to [0, 1]
                const sstNorm = clamp01((sst - MIN_SST) * INV_RANGE) + 0.5;

                const rowOff = y * width;
                for (let x = 0; x < width; x++) {
                    const idx = rowOff + x;
                    ctx.derived.sstByLatitude[idx] = isLandMask[idx] === 1 ? 0 : sstNorm;

                }
            }

            ctx.derived.moistureAvailability = blurMaskWithSAT_U8(ctx.derived.sstByLatitude, width, height, 16, 3, makeGetWindowForRow(map, coords))
            console.log(ctx.derived.moistureAvailability)
        },

        colorPixelsByIce: function (ctx: ColorContext) {
            const { width, height, coords } = ctx.inputs;
            const {
                iceLevel,
                latitudeBiasExponent,
                elevationOfIce,
                seaBias,
                landBias,
                elevationModifier,
                dryingOutExponent,
            } = ctx.params;

            const threshold = 1 - iceLevel;

            const { isLandMask, heightAboveSea, iceMask, moistureAvailability } = ctx.derived;

            const map = getMap();
            if (!map) return;

            // Compute latitude for each pixel row once
            const latByRow = new Float32Array(height);
            for (let py = 0; py < height; py++) {
                latByRow[py] = tileRowToLat(map, coords, py, height);
            }

            for (let p = 0; p < width * height; p++) {
                const py = (p / width) | 0;          // row index
                const latitude = latByRow[py];       // per-pixel latitude (via its row)

                const latitudeWeighting = Math.pow(Math.abs(latitude) / 90, latitudeBiasExponent);

                const elevation = heightAboveSea[p]; // 0 for sea, else elev - seaLevel
                const elevationWeighting = clamp01(elevation / elevationOfIce);
                const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1

                // const moistureAvailability = 1 - Math.pow(moistureAvailability[p], dryingOutExponent);
                const moistureAvailable = moistureAvailability[p] + 1;
                // const moistureAvailable = 1;

                const combined = clamp01(latitudeWeighting * (1 + elevationModifier * elevationWeighting) * landWeighting * moistureAvailable);
                iceMask[p] = combined > threshold ? 1 : 0;
            }
        },

        writeColorToPixels: function (ctx: ColorContext) {
            const { originalData, width, height } = ctx.inputs;
            const { seaLevel } = ctx.params;
            const { isLandMask, iceMask, moistureAvailability } = ctx.derived;

            const debug = false; // set false to disable moisture debug

            const imageData = new ImageData(width, height);
            const data = imageData.data;

            for (let i = 0, p = 0; i < data.length; i += 4, p++) {
                const elevation = originalData[i];

                let r: number, g: number, b: number;

                if (iceMask[p] === 1) {
                    [r, g, b] = iceColor();
                } else if (isLandMask[p] === 1) {
                    [r, g, b] = landColor(elevation);
                } else {
                    [r, g, b] = waterColor(elevation, seaLevel);
                }

                // ---- DEBUG OVERRIDE ----
                if (debug) {
                    const m = moistureAvailability[p]; // assumed 0..1
                    r = Math.round(m * 255);
                    g = 0;
                    b = 0;
                }

                data[i] = r | 0;
                data[i + 1] = g | 0;
                data[i + 2] = b | 0;
                data[i + 3] = 255;
            }

            return imageData;
        },


        colorPixels: function (ctx: ColorContext) {
            this.deriveEffectiveSeaLevel(ctx);
            this.colorPixelsBySeaLevel(ctx);
            this.colorPixelsByIce(ctx);
            return this.writeColorToPixels(ctx);
        },

        createTile: function (coords: L.Coords, done: (err: any, tile: HTMLElement) => void) {
            const tile = document.createElement("canvas");
            const ctx = tile.getContext("2d", { willReadFrequently: true });
            if (!ctx) { done(null, tile); return tile; }

            const size = this.getTileSize();
            tile.width = size.x;
            tile.height = size.y;

            const img = new Image();
            img.crossOrigin = "anonymous";

            img.src = tileUrl(coords);

            img.onload = () => {
                ctx.drawImage(img, 0, 0, size.x, size.y);

                const src = ctx.getImageData(0, 0, size.x, size.y);
                const originalData = new Uint8ClampedArray(src.data);

                // Store by the actual canvas element
                this._tileStore.set(tile, {
                    ctx,
                    width: size.x,
                    height: size.y,
                    originalData,
                    coords
                });
                const ctxObj: ColorContext = this.buildColorContext(originalData, size.x, size.y, coords);
                const colored = this.colorPixels(ctxObj);
                ctx.putImageData(colored, 0, 0);

                done(null, tile);
            };

            img.onerror = (e) => done(e, tile);

            return tile;
        },

        setParams: function (partial: Partial<RecolorParams>) {
            Object.assign(this.params, partial);
            this._recolorAllTiles();
        },

        _recolorAllTiles: function () {
            const tilesObj = (this as any)._tiles as Record<string, { el: HTMLElement }>;
            if (!tilesObj) return;

            Object.values(tilesObj).forEach(({ el }) => {
                if (!(el instanceof HTMLCanvasElement)) return;

                const rec = this._tileStore.get(el);
                if (!rec) return;

                const { ctx, width, height, originalData, coords } = rec;

                const ctxObj: ColorContext =
                    this.buildColorContext(originalData, width, height, coords);

                const colored = this.colorPixels(ctxObj);
                ctx.putImageData(colored, 0, 0);
            });
        },

        // Optional: keep memory tidy when Leaflet unloads tiles
        // (WeakMap already helps, but this is still nice)
        _removeTile: function (key: string) {
            const tile = (this as any)._tiles?.[key]?.el;
            if (tile instanceof HTMLCanvasElement) {
                // WeakMap doesn't need delete, but safe if you switch to Map later
                // this._tileStore.delete(tile);
            }
            return (L.GridLayer.prototype as any)._removeTile.call(this, key);
        },
    });


    // instantiate and return
    const layer = new (CanvasLayer as any) as RecolorLayer;
    return layer;
}

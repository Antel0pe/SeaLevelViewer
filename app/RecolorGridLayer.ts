// RecolorGridLayer.ts
import L from "leaflet";
import { tileRowToLat } from "./utils";
import { blurMaskWithSAT_U8, makeGetWindowForRow, windowByLatitudeAnchors, WindowSpec } from "./RectangleSum";

type TileRecord = {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    originalData?: Uint8ClampedArray;
    coords: L.Coords;
};

// type ColorContext = {
//     inputs: {
//         originalData: Uint8ClampedArray;
//         width: number;
//         height: number;
//         coords: L.Coords;
//     };
//     params: RecolorParams
//     derived: {
//         isLandMask: Uint8Array;          // 0 sea, 1 land
//         heightAboveSea: Uint8Array;      // 0 for sea, else (elev - seaLevel)
//         iceMask: Uint8Array;
//         effectiveSeaLevel: number;
//         moistureAvailability: Float32Array;
//         sstByLatitude: Float32Array;
//     };
// };

type WorldContext = {
    inputs: {
        originalData: Uint8ClampedArray; // the z=0 tile's RGBA
        width: number;                  // 256
        height: number;                 // 256
        coords: L.Coords;               // { x:0, y:0, z:0 }
    };
    params: RecolorParams;
    derived: {
        isLandMask: Uint8Array;          // 0 sea, 1 land
        heightAboveSea: Uint8Array;      // 0 for sea, else (elev - seaLevel)
        iceMask: Uint8Array;
        effectiveSeaLevel: number;
        moistureAvailability: Float32Array;
        sstByLatitude: Float32Array;
        continentalValue: Float32Array;
    };
    outputs: {
        latitudeWeighting: Float32Array;
        elevationWeighting: Float32Array;
        landWeighting: Float32Array;
        moistureAvailable: Float32Array;
        combined: Float32Array;
        threshold: Float32Array; // constant per world pixel, but stored for convenience
        continentalFactor: Float32Array;
        thermalGate: Float32Array;
        effectiveAccumulation: Float32Array;

        // --- temperature / melt diagnostics ---
        T_lat: Float32Array;
        T_elev: Float32Array;
        dT_global: Float32Array;
        T_mean: Float32Array;
        T_season: Float32Array;
        T_cont: Float32Array;

        Tw: Float32Array;
        Ts: Float32Array;

        meltPressure: Float32Array;
        melt: Float32Array;

        accum: Float32Array;
        iceSupply: Float32Array; // ice before melt (your `ice`)
        iceLeft: Float32Array;   // iceSupply - melt (unclamped)
        continental01: Float32Array;
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
    moistureBias: number;
    moistureScale: number;

    continentalBias: number;
    continentalScale: number;
};


export type RecolorLayer = L.GridLayer & {
    setParams(p: Partial<RecolorParams>): void;
    getInfoAtPoint(latlng: L.LatLng): LayerClickResult | null;
};

export type CanvasLayerCtor = new (opts?: L.GridLayerOptions) => RecolorLayer;

export type CreateRecolorLayerOpts = {
    getMap: () => L.Map | null;              // instead of mapRef
    tileUrl: (coords: L.Coords) => string;   // lets you swap sources easily
    initial: RecolorParams;
    tileSize?: number;
};

export type LayerClickResult = {
    latlng: L.LatLng;
    zoom: number;
    tile: { x: number; y: number; z: number };
    tilePixel: { x: number; y: number };
    worldIndex: number;
    gx: number;
    gy: number;
    worldLat: number;
    worldLng: number;

    latitudeWeighting: number;
    elevationWeighting: number;
    landWeighting: number;
    moistureAvailable: number;
    continentalValue: number;
    combined: number;
    threshold: number;
    ice: boolean;

    // optionally include raw derived values too
    isLand: number;
    heightAboveSea: number;
    moistureAvailability: number;
    continentalFactor: number;

    thermalGate: number;
    effectiveAccumulation: number;

    T_lat: number;
    T_elev: number;
    dT_global: number;
    T_mean: number;
    T_season: number;
    T_cont: number;

    Tw: number;
    Ts: number;

    meltPressure: number;
    melt: number;

    accum: number;
    iceSupply: number;
    iceLeft: number;
    continental01: number;
    sstByLatitude: number;
};

export function createRecolorLayer(opts: CreateRecolorLayerOpts): RecolorLayer {
    const {
        getMap,
        tileUrl,
        initial = {},
        tileSize = 256
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

        _world: null as WorldContext | null,
        _worldBasePromise: null as Promise<void> | null,

        // buildColorContext: function (
        //     originalData: Uint8ClampedArray,
        //     width: number,
        //     height: number,
        //     coords: L.Coords
        // ): ColorContext {
        //     const isLandMask = new Uint8Array(width * height);

        //     return {
        //         inputs: {
        //             originalData,
        //             width,
        //             height,
        //             coords,
        //         },
        //         params: this.params,
        //         derived: {
        //             isLandMask,
        //             heightAboveSea: new Uint8Array(width * height),
        //             iceMask: new Uint8Array(width * height),
        //             effectiveSeaLevel: this.params.seaLevel,
        //             moistureAvailability: new Float32Array(width * height),
        //             sstByLatitude: new Float32Array(width * height),
        //         },
        //     };
        // },

        buildWorldContext: function (
            originalData: Uint8ClampedArray,
            width: number,
            height: number,
            coords: L.Coords
        ): WorldContext {
            const n = width * height;

            return {
                inputs: {
                    originalData,
                    width,
                    height,
                    coords,
                },
                params: this.params,
                derived: {
                    isLandMask: new Uint8Array(n),
                    heightAboveSea: new Uint8Array(n),
                    iceMask: new Uint8Array(n),
                    effectiveSeaLevel: this.params.seaLevel,
                    moistureAvailability: new Float32Array(n),
                    sstByLatitude: new Float32Array(n),
                    continentalValue: new Float32Array(n),
                },
                outputs: {
                    latitudeWeighting: new Float32Array(n),
                    elevationWeighting: new Float32Array(n),
                    landWeighting: new Float32Array(n),
                    moistureAvailable: new Float32Array(n),
                    combined: new Float32Array(n),
                    threshold: new Float32Array(n),
                    continentalFactor: new Float32Array(n),
                    thermalGate: new Float32Array(n),
                    effectiveAccumulation: new Float32Array(n),

                    T_lat: new Float32Array(n),
                    T_elev: new Float32Array(n),
                    dT_global: new Float32Array(n),
                    T_mean: new Float32Array(n),
                    T_season: new Float32Array(n),
                    T_cont: new Float32Array(n),

                    Tw: new Float32Array(n),
                    Ts: new Float32Array(n),

                    meltPressure: new Float32Array(n),
                    melt: new Float32Array(n),

                    accum: new Float32Array(n),
                    iceSupply: new Float32Array(n),
                    iceLeft: new Float32Array(n),
                    continental01: new Float32Array(n),
                },
            };
        },


        // deriveEffectiveSeaLevel: function (ctx: ColorContext) {
        //     const { seaLevel, iceLevel, seaLevelDropDueToIce } = ctx.params; // iceLevel: 0..1

        //     const seaDrop = iceLevel * seaLevel * seaLevelDropDueToIce;

        //     // Clamp to [0, 255] so downstream logic stays sane
        //     let eff = seaLevel - seaDrop;
        //     if (eff < 0) eff = 0;
        //     if (eff > 255) eff = 255;

        //     ctx.derived.effectiveSeaLevel = eff;
        // },

        // colorPixelsBySeaLevel: function (ctx: ColorContext) {
        //     const { originalData, height, coords, width } = ctx.inputs;
        //     // const { seaLevel } = ctx.params;
        //     const { isLandMask, heightAboveSea, effectiveSeaLevel } = ctx.derived;

        //     for (let i = 0, p = 0; i < originalData.length; i += 4, p++) {
        //         const elevation = originalData[i];

        //         if (elevation < effectiveSeaLevel) {
        //             isLandMask[p] = 0;
        //             heightAboveSea[p] = 0;
        //         } else {
        //             isLandMask[p] = 1;

        //             // clamp because Uint8Array wraps on >255
        //             const h = elevation - effectiveSeaLevel;
        //             heightAboveSea[p] = h > 255 ? 255 : h < 0 ? 0 : h;
        //         }
        //     }

        //     const map = getMap();
        //     if (!map) return;
        //     const latByRow = new Float32Array(height);
        //     for (let py = 0; py < height; py++) {
        //         latByRow[py] = tileRowToLat(map, coords, py, height);
        //     }

        //     const MAX_SST = 29.5;  // equatorial warm ocean
        //     const MIN_SST = -1.8;  // freezing seawater
        //     const INV_RANGE = 1 / (MAX_SST - MIN_SST);

        //     for (let y = 0; y < height; y++) {
        //         const latDeg = latByRow[y];
        //         const latRad = (Math.abs(latDeg) * Math.PI) / 180;

        //         // Same latitude → SST shape as before
        //         const t = Math.pow(Math.cos(latRad), 1.6); // 1 at equator → 0 at poles
        //         let sst = MIN_SST + (MAX_SST - MIN_SST) * t;

        //         // subtle NH cooling asymmetry (optional but nice visually)
        //         if (latDeg > 0) {
        //             sst -= 0.8 * Math.pow(Math.sin(latRad), 1.2);
        //         }

        //         // Normalize to [0, 1]
        //         const sstNorm = clamp01((sst - MIN_SST) * INV_RANGE) + 0.5;

        //         const rowOff = y * width;
        //         for (let x = 0; x < width; x++) {
        //             const idx = rowOff + x;
        //             ctx.derived.sstByLatitude[idx] = isLandMask[idx] === 1 ? 0 : sstNorm;

        //         }
        //     }

        //     ctx.derived.moistureAvailability = blurMaskWithSAT_U8(ctx.derived.sstByLatitude, width, height, 16, 3, makeGetWindowForRow(map, coords))
        // },

        // colorPixelsByIce: function (ctx: ColorContext) {
        //     const { width, height, coords } = ctx.inputs;
        //     const {
        //         iceLevel,
        //         latitudeBiasExponent,
        //         elevationOfIce,
        //         seaBias,
        //         landBias,
        //         elevationModifier,
        //         dryingOutExponent,
        //     } = ctx.params;

        //     const threshold = 1 - iceLevel;

        //     const { isLandMask, heightAboveSea, iceMask, moistureAvailability } = ctx.derived;

        //     const map = getMap();
        //     if (!map) return;

        //     // Compute latitude for each pixel row once
        //     const latByRow = new Float32Array(height);
        //     for (let py = 0; py < height; py++) {
        //         latByRow[py] = tileRowToLat(map, coords, py, height);
        //     }

        //     for (let p = 0; p < width * height; p++) {
        //         const py = (p / width) | 0;          // row index
        //         const latitude = latByRow[py];       // per-pixel latitude (via its row)

        //         const latitudeWeighting = Math.pow(Math.abs(latitude) / 90, latitudeBiasExponent);

        //         const elevation = heightAboveSea[p]; // 0 for sea, else elev - seaLevel
        //         const elevationWeighting = clamp01(elevation / elevationOfIce);
        //         const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1

        //         // const moistureAvailability = 1 - Math.pow(moistureAvailability[p], dryingOutExponent);
        //         const moistureAvailable = moistureAvailability[p] + 1;
        //         // const moistureAvailable = 1;

        //         const combined = clamp01(latitudeWeighting * (1 + elevationModifier * elevationWeighting) * landWeighting * moistureAvailable);
        //         iceMask[p] = combined > threshold ? 1 : 0;
        //     }
        // },

        // writeColorToPixels: function (ctx: ColorContext) {
        //     const { originalData, width, height } = ctx.inputs;
        //     const { seaLevel } = ctx.params;
        //     const { isLandMask, iceMask, moistureAvailability } = ctx.derived;

        //     const debug = false; // set false to disable moisture debug

        //     const imageData = new ImageData(width, height);
        //     const data = imageData.data;

        //     for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        //         const elevation = originalData[i];

        //         let r: number, g: number, b: number;

        //         if (iceMask[p] === 1) {
        //             [r, g, b] = iceColor();
        //         } else if (isLandMask[p] === 1) {
        //             [r, g, b] = landColor(elevation);
        //         } else {
        //             [r, g, b] = waterColor(elevation, seaLevel);
        //         }

        //         // ---- DEBUG OVERRIDE ----
        //         if (debug) {
        //             const m = moistureAvailability[p]; // assumed 0..1
        //             r = Math.round(m * 255);
        //             g = 0;
        //             b = 0;
        //         }

        //         data[i] = r | 0;
        //         data[i + 1] = g | 0;
        //         data[i + 2] = b | 0;
        //         data[i + 3] = 255;
        //     }

        //     return imageData;
        // },


        // colorPixels: function (ctx: ColorContext) {
        //     this.deriveEffectiveSeaLevel(ctx);
        //     this.colorPixelsBySeaLevel(ctx);
        //     this.colorPixelsByIce(ctx);
        //     return this.writeColorToPixels(ctx);
        // },

        _ensureWorldBaseLoaded: function (): Promise<void> {
            // Already computed
            if (this._world) return Promise.resolve();

            // In-flight shared promise
            if (this._worldBasePromise) return this._worldBasePromise;

            // Start loading once
            this._worldBasePromise = new Promise<void>((resolve, reject) => {
                const z0: L.Coords = { x: 0, y: 0, z: 0 } as L.Coords;

                const img = new Image();
                img.crossOrigin = "anonymous";
                img.src = tileUrl(z0);

                img.onload = () => {
                    try {
                        const w = img.width;
                        const h = img.height;

                        const off = document.createElement("canvas");
                        off.width = w;
                        off.height = h;

                        const offCtx = off.getContext("2d", { willReadFrequently: true });
                        if (!offCtx) {
                            reject(new Error("Failed to create 2D context for world base tile"));
                            return;
                        }

                        offCtx.drawImage(img, 0, 0, w, h);

                        const imageData = offCtx.getImageData(0, 0, w, h);
                        const originalData = new Uint8ClampedArray(imageData.data);

                        this._world = this.buildWorldContext(originalData, w, h, z0);
                        this.recomputeWorldDerived();

                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                };

                img.onerror = (e) => {
                    reject(new Error("Failed to load z=0 world base tile image"));
                };
            });

            // If it fails, allow retry next time (don’t cache failure forever)
            this._worldBasePromise = this._worldBasePromise.catch((err: any) => {
                this._worldBasePromise = null;
                throw err;
            });

            return this._worldBasePromise;
        },


        createTile: function (coords: L.Coords, done: (err: any, tile: HTMLElement) => void) {
            const tile = document.createElement("canvas");
            const ctx = tile.getContext("2d", { willReadFrequently: true });
            if (!ctx) { done(null, tile); return tile; }

            const size = this.getTileSize();
            tile.width = size.x;
            tile.height = size.y;

            this._ensureWorldBaseLoaded()
                .then(() => {
                    const useNewGlobalSampling = true; // flip true/false here

                    if (useNewGlobalSampling) {
                        // NEW PIPELINE: sample from world + draw
                        this._tileStore.set(tile, {
                            ctx,
                            width: size.x,
                            height: size.y,
                            coords,
                        });


                        const colored = this.writeColorToPixels_global(coords, size.x, size.y);
                        ctx.putImageData(colored, 0, 0);
                        done(null, tile);
                        return;
                    }

                    // const img = new Image();
                    // img.crossOrigin = "anonymous";

                    // img.src = tileUrl(coords);

                    // img.onload = () => {
                    //     ctx.drawImage(img, 0, 0, size.x, size.y);

                    //     const src = ctx.getImageData(0, 0, size.x, size.y);
                    //     const originalData = new Uint8ClampedArray(src.data);

                    //     // Store by the actual canvas element
                    //     this._tileStore.set(tile, {
                    //         ctx,
                    //         width: size.x,
                    //         height: size.y,
                    //         originalData,
                    //         coords
                    //     });
                    //     const ctxObj: ColorContext = this.buildColorContext(originalData, size.x, size.y, coords);
                    //     const colored = this.colorPixels(ctxObj);
                    //     ctx.putImageData(colored, 0, 0);

                    //     done(null, tile);
                    // };

                    // img.onerror = (e) => done(e, tile);
                }).catch((e: any) => {
                    // world load failed; still finish tile so Leaflet doesn't hang
                    done(e, tile);
                });

            return tile;
        },

        _worldYToLatDeg_webMercator: function (worldY: number, worldHeight: number): number {
            // worldY in [0, worldHeight)
            // Map to "global pixel space" at z=0, then invert Web Mercator
            const yNorm = (worldY + 0.5) / worldHeight;          // 0..1 (pixel center)
            const mercY = Math.PI * (1 - 2 * yNorm);             // +pi at north edge -> -pi at south edge
            const latRad = Math.atan(Math.sinh(mercY));          // inverse mercator
            return (latRad * 180) / Math.PI;
        },

        deriveEffectiveSeaLevel_global: function (ctx: WorldContext) {
            const { seaLevel, iceLevel, seaLevelDropDueToIce } = ctx.params;

            const seaDrop = iceLevel * seaLevel * seaLevelDropDueToIce;

            let eff = seaLevel - seaDrop;
            if (eff < 0) eff = 0;
            if (eff > 255) eff = 255;

            ctx.derived.effectiveSeaLevel = eff;

        },

        colorPixelsBySeaLevel_global: function (ctx: WorldContext) {
            const { originalData, width, height } = ctx.inputs;
            const { isLandMask, heightAboveSea, effectiveSeaLevel } = ctx.derived;

            for (let i = 0, p = 0; i < originalData.length; i += 4, p++) {
                const elevation = originalData[i];

                if (elevation < effectiveSeaLevel) {
                    isLandMask[p] = 0;
                    heightAboveSea[p] = 0;
                } else {
                    isLandMask[p] = 1;

                    const h = elevation - effectiveSeaLevel;
                    heightAboveSea[p] = h > 255 ? 255 : h < 0 ? 0 : h;
                }
            }
        },

        computeMoisture_global: function (ctx: WorldContext) {
            const { width, height } = ctx.inputs;
            const { isLandMask, sstByLatitude } = ctx.derived;

            const MAX_SST = 29.5;
            const MIN_SST = -1.8;
            const INV_RANGE = 1 / (MAX_SST - MIN_SST);

            // Precompute latitude by WORLD row using Web Mercator inverse
            const latByRow = new Float32Array(height);
            for (let gy = 0; gy < height; gy++) {
                latByRow[gy] = this._worldYToLatDeg_webMercator(gy, height);
            }

            // vaporCapacity(lat) = clamp01(cos(|lat|))  (ocean-only)
            for (let y = 0; y < height; y++) {
                const latDeg = latByRow[y];
                const latRad = (Math.abs(latDeg) * Math.PI) / 180;

                const vaporCap = clamp01(Math.cos(latRad));

                const rowOff = y * width;
                for (let x = 0; x < width; x++) {
                    const idx = rowOff + x;
                    sstByLatitude[idx] = isLandMask[idx] === 1 ? 0 : vaporCap;
                }
            }

            // World-row window chooser (same windowByLatitudeAnchors, just world lat)
            const getWindowForRow = (y: number, h: number, r: number) => {
                const latDeg = latByRow[y]; // already computed
                return windowByLatitudeAnchors(latDeg, r);
            };

            ctx.derived.moistureAvailability = blurMaskWithSAT_U8(
                ctx.derived.sstByLatitude,
                width,
                height,
                width / 8,
                3,
                getWindowForRow
            );

            // Symmetric, centered blur window chooser (same window for every row)
            const getCenteredWindowForRow = (y: number, h: number, r: number): WindowSpec => {
                return { dx0: -r, dx1: +r, dy0: -r, dy1: +r };
            };

            const landMaskF32 = new Float32Array(width * height);
            for (let p = 0; p < width * height; p++) landMaskF32[p] = isLandMask[p]; // 0 or 1

            ctx.derived.continentalValue = blurMaskWithSAT_U8(
                landMaskF32,
                width,
                height,
                width / 8,
                3,
                getCenteredWindowForRow
            );

        },


        // colorPixelsByIce_global: function (ctx: WorldContext) {
        //     const { width, height } = ctx.inputs;
        //     const {
        //         iceLevel,
        //         latitudeBiasExponent,
        //         elevationOfIce,
        //         seaBias,
        //         landBias,
        //         elevationModifier,
        //         dryingOutExponent,

        //         moistureBias,
        //         moistureScale,

        //         continentalBias,
        //         continentalScale,
        //     } = ctx.params;

        //     const threshold = 1 - iceLevel;

        //     const { isLandMask, heightAboveSea, iceMask, moistureAvailability, continentalValue } = ctx.derived;

        //     // Compute latitude for each WORLD row once (Web Mercator, z=0 pixel space)
        //     const latByRow = new Float32Array(height);
        //     for (let gy = 0; gy < height; gy++) {
        //         latByRow[gy] = this._worldYToLatDeg_webMercator(gy, height);
        //     }

        //     for (let p = 0; p < width * height; p++) {
        //         const gy = (p / width) | 0;
        //         const latitude = latByRow[gy];

        //         const x = Math.abs(latitude); // degrees
        //         const latitudeWeighting = Math.sin((x * Math.PI) / 180);

        //         const elevation = heightAboveSea[p];
        //         const elevationFactor = clamp01(elevation / elevationOfIce);

        //         // keep this for output/debug, but we won't use it as a multiplicative gate anymore
        //         const elevationWeighting = 1 + elevationModifier * elevationFactor;

        //         // keep existing land weighting (user-controlled), but treat it as a *melt* modifier (small term)
        //         const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1

        //         // --- ACCUMULATION (only moisture) ---
        //         const moistureAvailable =
        //             (moistureAvailability[p] * moistureScale) + moistureBias;

        //         // clamp to a usable 0..1 accumulation signal (you can remove clamp if you want >1 to mean "very wet")
        //         // const accum = clamp01(moistureAvailable);
        //         const accum = moistureAvailable;

        //         // --- MELT PRESSURE (weighted sum, latitude-dominant) ---
        //         // convert "coldness" into "meltiness": high near equator, low near poles
        //         const latMelt = 1 - latitudeWeighting;

        //         // continentalness: already scaled/bias'd, and damped by (1 - latitudeWeighting) in your code.
        //         // Keep that idea so continental can't veto poles.
        //         const continentalFactor =
        //             ((continentalValue[p] * continentalScale) + continentalBias);

        //         // treat landWeighting as a small melt-side modifier; keep it bounded
        //         const landMelt = clamp01(landWeighting);

        //         // elevation reduces melt (cooling). Use elevationFactor directly as the cooling term.
        //         const elevCooling = elevationFactor;

        //         // weights: latitude should dominate; others are small nudges
        //         const wLat = 0.9;
        //         const wCont = 0.2;
        //         const wLand = 0.15;
        //         const wElev = 0.15;
        //         let meltPressure = (
        //             wLat * latMelt
        //             + wCont * continentalFactor
        //             + wLand * landMelt
        //             - wElev * elevCooling
        //         );

        //         meltPressure = clamp01(meltPressure);

        //         // global melt scale (your ice slider): lower => less melt => more ice.
        //         // Reuse `threshold` as this scale without renaming.
        //         const globalMelt = clamp01(threshold);
        //         meltPressure *= globalMelt;

        //         // --- DECISION ---
        //         // ice if accumulation beats melt pressure
        //         let effectiveAccumulation = accum;
        //         const thermalGate = meltPressure; // no longer a multiplicative gate; keep output slot stable

        //         const combined = clamp01(effectiveAccumulation - meltPressure);

        //         ctx.outputs.latitudeWeighting[p] = latitudeWeighting;
        //         ctx.outputs.elevationWeighting[p] = elevationWeighting;
        //         ctx.outputs.landWeighting[p] = landWeighting;
        //         ctx.outputs.moistureAvailable[p] = moistureAvailable;
        //         ctx.outputs.combined[p] = combined;
        //         ctx.outputs.threshold[p] = threshold;
        //         ctx.outputs.continentalFactor[p] = continentalFactor;
        //         ctx.outputs.thermalGate[p] = thermalGate;
        //         ctx.outputs.effectiveAccumulation[p] = effectiveAccumulation;

        //         iceMask[p] = (effectiveAccumulation > meltPressure) ? 1 : 0;
        //     }

        // },
        colorPixelsByIce_global: function (ctx: WorldContext) {
            const { width, height } = ctx.inputs;
            const {
                iceLevel,
                latitudeBiasExponent,
                elevationOfIce,
                seaBias,
                landBias,
                elevationModifier,
                dryingOutExponent,

                moistureBias,
                moistureScale,

                continentalBias,
                continentalScale,
            } = ctx.params;

            // Keep this for UI/debug continuity (even though we no longer use it as a melt scale)
            const threshold = 1 - iceLevel;

            const { isLandMask, heightAboveSea, iceMask, moistureAvailability, continentalValue } = ctx.derived;

            // --- Temperature model constants (°C-like units) ---
            // These are intended as reasonable defaults; tune as needed.
            const A = 20;     // mean equator-to-pole contrast
            const T_EQ = 27;     // mean annual equatorial surface temp (°C)
            const T_POLE = -25; // mean annual polar surface temp (°C)
            const L = 6.5;    // °C per km lapse rate
            const S = 12;     // seasonal amplitude scale
            const C = 20;      // summer continental warming scale
            const DELTA = 18;  // max global cooling at iceLevel=1
            const ELEV_KM_MAX = 5;   // maps elevationFactor (0..1) to 0..5 km
            const METERS_PER_ELEV_UNIT = 77; // choose this based on your source DEM


            // Melt conversion: converts °C-like summer warmth into "ice units" comparable to accum
            // Since accum can be >1 if you bias/scale moisture, keep this small.
            const k = 1 / 10;

            // Compute latitude for each WORLD row once (Web Mercator, z=0 pixel space)
            const latByRow = new Float32Array(height);
            for (let gy = 0; gy < height; gy++) {
                latByRow[gy] = this._worldYToLatDeg_webMercator(gy, height);
            }

            for (let p = 0; p < width * height; p++) {
                const gy = (p / width) | 0;
                const latitude = latByRow[gy];

                const x = Math.abs(latitude); // degrees
                const latRad = (x * Math.PI) / 180;
                const latitudeWeighting = Math.sin(latRad);

                // Land hard gate
                if (isLandMask[p] === 0) {
                    iceMask[p] = 0;

                    // outputs (keep them stable)
                    ctx.outputs.latitudeWeighting[p] = latitudeWeighting;
                    ctx.outputs.elevationWeighting[p] = 0;
                    ctx.outputs.landWeighting[p] = 0;
                    ctx.outputs.moistureAvailable[p] = 0;
                    ctx.outputs.combined[p] = 0;
                    ctx.outputs.threshold[p] = threshold;
                    ctx.outputs.continentalFactor[p] = 0;
                    ctx.outputs.thermalGate[p] = 0;
                    ctx.outputs.effectiveAccumulation[p] = 0;

                    ctx.outputs.T_lat[p] = 0;
                    ctx.outputs.T_elev[p] = 0;
                    ctx.outputs.dT_global[p] = 0;
                    ctx.outputs.T_mean[p] = 0;
                    ctx.outputs.T_season[p] = 0;
                    ctx.outputs.T_cont[p] = 0;
                    ctx.outputs.Tw[p] = 0;
                    ctx.outputs.Ts[p] = 0;
                    ctx.outputs.meltPressure[p] = 0;
                    ctx.outputs.melt[p] = 0;
                    ctx.outputs.accum[p] = 0;
                    ctx.outputs.iceSupply[p] = 0;
                    ctx.outputs.iceLeft[p] = 0;
                    ctx.outputs.continental01[p] = 0;

                    continue;
                }

                const elevation = heightAboveSea[p];
                const elevation_m = heightAboveSea[p] * METERS_PER_ELEV_UNIT;
                const elevation_km = elevation_m / 1000;

                // keep this for output/debug
                const elevationFactor = clamp01(elevation / elevationOfIce);
                const elevationWeighting = 1 + elevationModifier * elevationFactor;

                // keep existing land weighting (for debug/UI continuity)
                const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1

                // --- ACCUMULATION (only moisture) ---
                const moistureAvailable =
                    (moistureAvailability[p] * moistureScale) + moistureBias;

                const accum = moistureAvailable;

                // --- TEMPERATURE MODEL (Tw/Ts) ---
                const f = Math.pow(Math.cos(latRad), 1.3);
                const T_lat = T_POLE + (T_EQ - T_POLE) * f;


                // const elevation_km = ELEV_KM_MAX * elevationFactor;
                const T_elev = -L * elevation_km;

                const dT_global = -DELTA * iceLevel;

                const T_mean = T_lat + T_elev + dT_global;

                const T_season = S * Math.sin(latRad);

                const continentalRaw =
                    (continentalValue[p] * continentalScale) + continentalBias;
                const COAST = 0.5;
                const continental01 = clamp01((continentalRaw - COAST) / (1 - COAST));

                const T_cont = C * continental01;

                const Tw = T_mean - T_season;
                const Ts = T_mean + T_season + T_cont;

                // --- ICE FORMATION + MELT ---
                // if winter is freezing (Tw <= 0), all available snow becomes ice supply
                const ice = (Tw <= 0) ? accum : 0;

                // only melts if summer is above freezing
                const meltPressure = Math.max(0, Ts);
                const melt = k * meltPressure;

                const iceLeft = ice - melt;

                // Outputs (keep stable fields)
                ctx.outputs.latitudeWeighting[p] = latitudeWeighting;
                ctx.outputs.elevationWeighting[p] = elevationWeighting;
                ctx.outputs.landWeighting[p] = landWeighting;
                ctx.outputs.moistureAvailable[p] = moistureAvailable;

                // combined is now "remaining ice amount" (clamped to 0..1 for debug)
                ctx.outputs.combined[p] = clamp01(iceLeft);

                ctx.outputs.threshold[p] = threshold;

                // keep continentalFactor output slot meaningful
                ctx.outputs.continentalFactor[p] = continentalRaw;

                // thermalGate: 1 if winter allows accumulation, else 0
                ctx.outputs.thermalGate[p] = (Tw <= 0) ? 1 : 0;

                ctx.outputs.effectiveAccumulation[p] = ice;

                ctx.outputs.accum[p] = accum;
                ctx.outputs.T_lat[p] = T_lat;
                ctx.outputs.T_elev[p] = T_elev;
                ctx.outputs.dT_global[p] = dT_global;
                ctx.outputs.T_mean[p] = T_mean;
                ctx.outputs.T_season[p] = T_season;
                ctx.outputs.T_cont[p] = T_cont;
                ctx.outputs.Tw[p] = Tw;
                ctx.outputs.Ts[p] = Ts;
                ctx.outputs.meltPressure[p] = meltPressure;
                ctx.outputs.melt[p] = melt;
                ctx.outputs.iceSupply[p] = ice;
                ctx.outputs.iceLeft[p] = iceLeft;
                ctx.outputs.continental01[p] = continental01;


                iceMask[p] = (iceLeft > 0) ? 1 : 0;
            }

        },


        recomputeWorldDerived: function () {
            if (!this._world) return;

            // Always keep params reference fresh (in case setParams mutated this.params)
            this._world.params = this.params;

            // Keep effectiveSeaLevel initialized
            //   this._world.derived.effectiveSeaLevel = this.params.seaLevel;

            this.deriveEffectiveSeaLevel_global(this._world);
            this.colorPixelsBySeaLevel_global(this._world);
            this.computeMoisture_global(this._world);
            this.colorPixelsByIce_global(this._world);

        },

        _tilePixelToWorldIndex_z0: function (
            coords: L.Coords,
            px: number,
            py: number,
            worldW: number,
            worldH: number,
            tileSize: number,
        ): number {
            const worldPx = coords.x * tileSize + px;
            const worldPy = coords.y * tileSize + py;

            const scale = 1 << (coords.z | 0);

            const gx = Math.floor(worldPx / scale);
            const gy = Math.floor(worldPy / scale);

            const cx = gx < 0 ? 0 : gx >= worldW ? worldW - 1 : gx;
            const cy = gy < 0 ? 0 : gy >= worldH ? worldH - 1 : gy;

            return cy * worldW + cx;
        },


        writeColorToPixels_global: function (
            coords: L.Coords,
            tileW: number,
            tileH: number
        ): ImageData {
            if (!this._world) {
                return new ImageData(tileW, tileH);
            }

            const world = this._world;
            const { width: worldW, height: worldH, originalData: worldRGBA } = world.inputs;
            const { seaLevel } = world.params;
            const { isLandMask, iceMask, moistureAvailability } = world.derived;

            const debug = false; // keep your moisture debug toggle

            const imageData = new ImageData(tileW, tileH);
            const data = imageData.data;

            // Walk tile pixels
            for (let py = 0; py < tileH; py++) {
                for (let px = 0; px < tileW; px++) {
                    const tIndex = py * tileW + px;
                    const di = tIndex * 4;

                    const wIndex = this._tilePixelToWorldIndex_z0(coords, px, py, worldW, worldH, this.getTileSize().x);

                    const elevation = worldRGBA[wIndex * 4]; // red channel as before

                    let r: number, g: number, b: number;

                    if (iceMask[wIndex] === 1) {
                        [r, g, b] = iceColor();
                    } else if (isLandMask[wIndex] === 1) {
                        [r, g, b] = landColor(elevation);
                    } else {
                        [r, g, b] = waterColor(elevation, seaLevel);
                    }

                    if (debug) {
                        const m = moistureAvailability[wIndex]; // assumed 0..1
                        r = Math.round(m * 255);
                        g = 0;
                        b = 0;
                    }

                    data[di] = r | 0;
                    data[di + 1] = g | 0;
                    data[di + 2] = b | 0;
                    data[di + 3] = 255;
                }
            }

            return imageData;
        },


        setParams: function (partial: Partial<RecolorParams>) {
            let useNewPath = true;

            // if (!useNewPath) {
            //     Object.assign(this.params, partial);
            //     this._recolorAllTiles();
            // } else {
            Object.assign(this.params, partial);

            // Ensure world exists (async) then recompute + repaint
            this._ensureWorldBaseLoaded()
                .then(() => {
                    this.recomputeWorldDerived();
                    this._recolorAllTiles_global();
                })
                .catch((e: any) => {
                    // Optional: surface error
                    console.error("setParams world load failed", e);
                });
            // }

        },

        // _recolorAllTiles: function () {
        //     const tilesObj = (this as any)._tiles as Record<string, { el: HTMLElement }>;
        //     if (!tilesObj) return;

        //     Object.values(tilesObj).forEach(({ el }) => {
        //         if (!(el instanceof HTMLCanvasElement)) return;

        //         const rec = this._tileStore.get(el);
        //         if (!rec) return;

        //         const { ctx, width, height, originalData, coords } = rec;

        //         const ctxObj: ColorContext =
        //             this.buildColorContext(originalData, width, height, coords);

        //         const colored = this.colorPixels(ctxObj);
        //         ctx.putImageData(colored, 0, 0);
        //     });
        // },

        _recolorAllTiles_global: function () {
            const tilesObj = (this as any)._tiles as Record<string, { el: HTMLElement }>;
            if (!tilesObj) return;

            Object.values(tilesObj).forEach(({ el }) => {
                if (!(el instanceof HTMLCanvasElement)) return;

                // For the global pipeline, we still need ctx + coords + size.
                // If you kept _tileStore for now, use it:
                const rec = this._tileStore.get(el);
                if (!rec) return;

                const { ctx, width, height, coords } = rec;

                const colored = this.writeColorToPixels_global(coords, width, height);
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

        getInfoAtPoint: function (latlng: L.LatLng): LayerClickResult | null {
            const map = getMap();
            if (!map) return null;
            if (!this._world) return null;

            const world: WorldContext = this._world;
            const z = map.getZoom();
            const tileSize = this.getTileSize().x; // assume square

            const p = map.project(latlng, z); // world pixel coords at zoom z

            const tileX = Math.floor(p.x / tileSize);
            const tileY = Math.floor(p.y / tileSize);
            const px = Math.floor(p.x - tileX * tileSize);
            const py = Math.floor(p.y - tileY * tileSize);

            // const coords = new L.Coords(tileX, tileY, z);
            const coords: L.Coords = { x: tileX, y: tileY, z: z } as L.Coords;

            const worldW = world.inputs.width;
            const worldH = world.inputs.height;

            const wIndex = this._tilePixelToWorldIndex_z0(coords, px, py, worldW, worldH, tileSize);

            const gx = wIndex % worldW;
            const gy = (wIndex / worldW) | 0;

            const latitudeDeg = this._worldYToLatDeg_webMercator(gy, worldH);
            const longitudeDeg = (gx / worldW) * 360 - 180;


            const out = world.outputs;
            const der = world.derived;

            const combined = out.combined[wIndex];
            const threshold = out.threshold[wIndex];

            return {
                latlng,
                zoom: z,
                tile: { x: tileX, y: tileY, z },
                tilePixel: { x: px, y: py },
                worldIndex: wIndex,
                gx,
                gy,

                worldLat: latitudeDeg,
                worldLng: longitudeDeg,

                latitudeWeighting: out.latitudeWeighting[wIndex],
                elevationWeighting: out.elevationWeighting[wIndex],
                landWeighting: out.landWeighting[wIndex],
                moistureAvailable: out.moistureAvailable[wIndex],
                continentalFactor: out.continentalFactor[wIndex],
                combined,
                threshold,
                ice: der.iceMask[wIndex] > 0,

                isLand: der.isLandMask[wIndex],
                heightAboveSea: der.heightAboveSea[wIndex],
                moistureAvailability: der.moistureAvailability[wIndex],
                continentalValue: der.continentalValue[wIndex],
                thermalGate: out.thermalGate[wIndex],
                effectiveAccumulation: out.effectiveAccumulation[wIndex],

                T_lat: out.T_lat[wIndex],
                T_elev: out.T_elev[wIndex],
                dT_global: out.dT_global[wIndex],
                T_mean: out.T_mean[wIndex],
                T_season: out.T_season[wIndex],
                T_cont: out.T_cont[wIndex],

                Tw: out.Tw[wIndex],
                Ts: out.Ts[wIndex],

                meltPressure: out.meltPressure[wIndex],
                melt: out.melt[wIndex],

                accum: out.accum[wIndex],
                iceSupply: out.iceSupply[wIndex],
                iceLeft: out.iceLeft[wIndex],
                continental01: out.continental01[wIndex],
                sstByLatitude: der.sstByLatitude[wIndex],

            };
        },

    });

    // instantiate and return
    const layer = new (CanvasLayer as any)({
        tileSize: tileSize,
        noWrap: true,
    }) as RecolorLayer;
    return layer;
}

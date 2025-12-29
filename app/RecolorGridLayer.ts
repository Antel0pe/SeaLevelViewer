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
    initial: RecolorParams
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
                        const w = 256;
                        const h = 256;

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

            for (let y = 0; y < height; y++) {
                const latDeg = latByRow[y];
                const latRad = (Math.abs(latDeg) * Math.PI) / 180;

                const t = Math.pow(Math.cos(latRad), 1.6);
                let sst = MIN_SST + (MAX_SST - MIN_SST) * t;

                // subtle NH cooling asymmetry (optional but nice visually)
                // if (latDeg > 0) {
                //     sst -= 0.8 * Math.pow(Math.sin(latRad), 1.2);
                // }

                const sstNorm = clamp01((sst - MIN_SST) * INV_RANGE);

                const rowOff = y * width;
                for (let x = 0; x < width; x++) {
                    const idx = rowOff + x;
                    sstByLatitude[idx] = isLandMask[idx] === 1 ? 0 : sstNorm;
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
                16,
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
                25,
                3,
                getCenteredWindowForRow
            );


        },


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

            const threshold = 1 - iceLevel;

            const { isLandMask, heightAboveSea, iceMask, moistureAvailability, continentalValue } = ctx.derived;

            // Compute latitude for each WORLD row once (Web Mercator, z=0 pixel space)
            const latByRow = new Float32Array(height);
            for (let gy = 0; gy < height; gy++) {
                latByRow[gy] = this._worldYToLatDeg_webMercator(gy, height);
            }

            for (let p = 0; p < width * height; p++) {
                const gy = (p / width) | 0;
                const latitude = latByRow[gy];

                // let latitudeWeighting = Math.pow(Math.abs(latitude) / 90, latitudeBiasExponent);
                // const latitudeWeighting = 1 - Math.cos(Math.abs(latitude) * Math.PI / 180);
                const x = Math.abs(latitude); // degrees
                const k = 0.1;
                const t = 45;

                const latitudeWeighting =
                    1 / (1 + Math.exp(-k * (x - t)));


                const elevation = heightAboveSea[p];
                const elevationFactor = clamp01(elevation / elevationOfIce);
                const elevationWeighting = 1 + elevationModifier * elevationFactor;


                const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1

                const moistureAvailable =
                    (moistureAvailability[p] * moistureScale) + moistureBias;

                const continentalFactor =
                    ((continentalValue[p] * continentalScale) + continentalBias) * clamp01(1 - latitudeWeighting);

                const thermalGate = latitudeWeighting * elevationWeighting * landWeighting;

                // accumulation minus summer melt
                let effectiveAccumulation = moistureAvailable - continentalFactor;
                const maxBoost = 1.0;                 // sets “0.03 -> at least ~1” at l≈1
                const B = maxBoost * Math.pow(latitudeWeighting, 7); // how much latitude can add at most
                const tau = 0.003 + 0.05 * (1 - Math.pow(latitudeWeighting, 4)); // small at poles, larger at low l

                effectiveAccumulation = effectiveAccumulation + B * (1 - Math.exp(-effectiveAccumulation / tau));
                // ice potential
                const combined = clamp01(
                    thermalGate * effectiveAccumulation
                );

                ctx.outputs.latitudeWeighting[p] = latitudeWeighting;
                ctx.outputs.elevationWeighting[p] = elevationWeighting;
                ctx.outputs.landWeighting[p] = landWeighting;
                ctx.outputs.moistureAvailable[p] = moistureAvailable;
                ctx.outputs.combined[p] = combined;
                ctx.outputs.threshold[p] = threshold;
                ctx.outputs.continentalFactor[p] = continentalFactor;
                ctx.outputs.thermalGate[p] = thermalGate;
                ctx.outputs.effectiveAccumulation[p] = effectiveAccumulation;


                iceMask[p] = combined > threshold ? 1 : 0;
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
            worldH: number
        ): number {
            // find in absolute tile space which pixel im in
            const worldPx = (coords.x << 8) + px; // coords.x * 256 + px
            const worldPy = (coords.y << 8) + py; // coords.y * 256 + py

            // find what pixel this corresponds to at z=0
            const shift = coords.z | 0;
            const gx = worldPx >> shift;
            const gy = worldPy >> shift;

            // Clamp just in case (shouldn’t be needed in ideal world, but keeps it safe)
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

                    const wIndex = this._tilePixelToWorldIndex_z0(coords, px, py, worldW, worldH);

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

            if (!useNewPath) {
                Object.assign(this.params, partial);
                this._recolorAllTiles();
            } else {
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
            }

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

            const wIndex = this._tilePixelToWorldIndex_z0(coords, px, py, worldW, worldH);

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
                ice: combined > threshold,

                isLand: der.isLandMask[wIndex],
                heightAboveSea: der.heightAboveSea[wIndex],
                moistureAvailability: der.moistureAvailability[wIndex],
                continentalValue: der.continentalValue[wIndex],
                thermalGate: out.thermalGate[wIndex],
                effectiveAccumulation: out.effectiveAccumulation[wIndex],

            };
        },

    });




    // instantiate and return
    const layer = new (CanvasLayer as any) as RecolorLayer;
    return layer;
}

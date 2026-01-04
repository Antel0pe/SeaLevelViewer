// RecolorGridLayer.ts
import L from "leaflet";
import { tileRowToLat } from "./utils";
import { blurMaskWithSAT_U8, makeGetWindowForRow, windowByLatitudeAnchors, WindowSpec } from "./RectangleSum";
import { RecolorParams, WorldContext, VIEW_TYPE, RGB, LayerClickResult } from "./types";
import { computeMoistureAvailabilityDijkstra, Dir4 } from "./computeMoistureAvailabilityDijkstra";

type TileRecord = {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    originalData?: Uint8ClampedArray;
    coords: L.Coords;
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

    const landColor = (elev: number, seaLevel: number) => {
        // elev + seaLevel assumed in [0..255]
        const denom = Math.max(1, 255 - seaLevel); // avoid divide-by-zero if seaLevel==255
        const t = Math.max(0, Math.min(1, (elev - seaLevel) / denom)); // seaLevel..255 -> 0..1

        const r = lerp(LOW_LAND[0], HIGH_LAND[0], t);
        const g = lerp(LOW_LAND[1], HIGH_LAND[1], t);
        const b = lerp(LOW_LAND[2], HIGH_LAND[2], t);

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

                const vaporCap = clamp01(Math.pow(Math.cos(latRad), 3));

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

            // ctx.derived.moistureAvailability = blurMaskWithSAT_U8(
            //     ctx.derived.sstByLatitude,
            //     width,
            //     height,
            //     width / 8,
            //     3,
            //     getWindowForRow
            // );

            // Put these inside computeMoisture_global right before you call computeMoistureAvailabilityDijkstra

            const METERS_PER_ELEV_UNIT = 77;

            // --- Cold multiplier ---
            // Interpretation: moving into colder air forces moisture out faster (shorter e-folding length).
            // We model this as a latitude-based multiplier >= 1.
            //
            // Shape notes:
            // - 0°: ~1.0 (tropics hold moisture longer)
            // - ~45°: ~2–3x loss
            // - ~60°+: ~4–6x loss
            //
            // This is intentionally strong because your grid step is big (~50 km).
            const coldMultiplier = (p: number) => {
                const y = (p / width) | 0;
                const lat = Math.abs(latByRow[y]); // 0..~85 in WebMercator

                // Smooth ramp: 0 at equator, ~1 near poles
                const t = Math.min(1, lat / 75); // treat 75° as "polar"
                const t2 = t * t;

                // Multiplicative amplification of land step cost
                // 1 + A * t^2  (A=5 -> up to ~6x at high lat)
                const A = 1.5;
                return 1 + A * t2;
            };

            // --- Elevation penalty ---
            // Interpretation: as air is forced up (orographic lift), it precipitates and loses moisture.
            // We add an *additive* per-step penalty on land that increases with elevation.
            //
            // We want this to be small at low elevations and significant for major mountains.
            // With METERS_PER_ELEV_UNIT=77, heightAboveSea is 0..~255-ish but only meaningful on land.
            //
            // Design:
            // - below 500 m: ~0 penalty
            // - 1000–2000 m: noticeable
            // - 3000–5000 m: strong loss
            const elevationPenalty = (u: number, v: number) => {
                // only matters when entering land (you already only call on land v, but keep safe)
                if (isLandMask[v] === 0) return 0;

                const hu = ctx.derived.heightAboveSea[u] * METERS_PER_ELEV_UNIT;
                const hv = ctx.derived.heightAboveSea[v] * METERS_PER_ELEV_UNIT;

                const dh = hv - hu;              // meters
                const upslope = Math.max(0, dh); // only penalize lifting

                // Soft knee so tiny bumps do almost nothing
                const D0 = 100;   // meters: start of meaningful lift
                const D1 = 1200;  // meters: "big" lift over one step (your pixels are huge)
                const t = Math.max(0, Math.min(1, (upslope - D0) / (D1 - D0)));

                // Additive per-step penalty. Start small.
                const Pmax = 0.06;
                return Pmax * t * t;
            };

            const directionPenalty = (u: number, v: number, dir: Dir4) => {
                const y = (u / width) | 0;
                const lat = Math.abs(latByRow[y]);

                // --- Tunables ---
                const ALONG = 0.0;
                const CROSS = 0.02;
                const AGAINST = 0.06;
                const POLAR = 0.05;

                // 0–30°: easterlies (east → west)
                if (lat < 30) {
                    if (dir === 1) return ALONG;    // westward
                    if (dir === 0) return AGAINST;  // eastward
                    return CROSS;                   // north/south
                }

                // 30–60°: westerlies (west → east)
                if (lat < 60) {
                    if (dir === 0) return ALONG;    // eastward
                    if (dir === 1) return AGAINST;  // westward
                    return CROSS;                   // north/south
                }

                // >60°: polar – weak, chaotic, damped
                return POLAR;
            };



            ctx.derived.moistureAvailability = computeMoistureAvailabilityDijkstra(
                isLandMask,
                sstByLatitude,
                width,
                height,
                {
                    coldMultiplier,
                    elevationPenalty,
                    directionPenalty,
                }
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
            // const L = 6.5;    // °C per km lapse rate
            const L = 0.0;
            const S = 12;     // seasonal amplitude scale
            const C = 20;      // summer continental warming scale
            const DELTA = 18;  // max global cooling at iceLevel=1
            const ELEV_KM_MAX = 5;   // maps elevationFactor (0..1) to 0..5 km
            const METERS_PER_ELEV_UNIT = 77; // choose this based on your source DEM


            // Melt conversion: converts °C-like summer warmth into "ice units" comparable to accum
            // Since accum can be >1 if you bias/scale moisture, keep this small.
            const k = 1 / 20;

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


                iceMask[p] = (iceLeft > 0.0) ? 1 : 0;
                // iceMask[p] = (iceLeft > 0.05) ? 1 : 0;
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

        viewColorAtWorldIndex: function (
            world: WorldContext,
            viewType: VIEW_TYPE,
            wIndex: number
        ): RGB {
            const { originalData: worldRGBA } = world.inputs;
            const { seaLevel } = world.params;
            const { isLandMask, iceMask, moistureAvailability, sstByLatitude } = world.derived;

            const elevation = worldRGBA[wIndex * 4]; // red channel

            let r: number, g: number, b: number;

            // Each case gets its own explicit logic (even if repeated)
            if (viewType === VIEW_TYPE.LAND_SEA) {
                if (isLandMask[wIndex] === 1) {
                    [r, g, b] = landColor(elevation, seaLevel);
                } else {
                    [r, g, b] = waterColor(elevation, seaLevel);
                }
                return [r, g, b];
            }

            if (viewType === VIEW_TYPE.LAND_SEA_ICE) {
                if (iceMask[wIndex] === 1) {
                    [r, g, b] = iceColor();
                } else if (isLandMask[wIndex] === 1) {
                    [r, g, b] = landColor(elevation, seaLevel);
                } else {
                    [r, g, b] = waterColor(elevation, seaLevel);
                }
                return [r, g, b];
            }

            if (viewType === VIEW_TYPE.MOISTURE_AVAILABILITY) {
                const m = moistureAvailability[wIndex]; // assumed 0..1
                r = Math.round(m * 255);
                g = 0;
                b = 0;
                return [r, g, b];
            }

            if (viewType === VIEW_TYPE.SST_BY_LATITUDE) {
                const m = sstByLatitude[wIndex]; // assumed 0..1
                r = Math.round(m * 255);
                g = 0;
                b = 0;
                return [r, g, b];
            }

            return [0, 0, 0];
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
            const { seaLevel, viewType } = world.params;
            const { isLandMask, iceMask, moistureAvailability } = world.derived;

            const debug = true; // keep your moisture debug toggle

            const imageData = new ImageData(tileW, tileH);
            const data = imageData.data;

            // Walk tile pixels
            for (let py = 0; py < tileH; py++) {
                for (let px = 0; px < tileW; px++) {
                    const tIndex = py * tileW + px;
                    const di = tIndex * 4;

                    const wIndex = this._tilePixelToWorldIndex_z0(coords, px, py, worldW, worldH, this.getTileSize().x);

                    const elevation = worldRGBA[wIndex * 4]; // red channel as before

                    // let r: number, g: number, b: number;

                    // if (iceMask[wIndex] === 1) {
                    //     [r, g, b] = iceColor();
                    // } else if (isLandMask[wIndex] === 1) {
                    //     [r, g, b] = landColor(elevation, seaLevel);
                    // } else {
                    //     [r, g, b] = waterColor(elevation, seaLevel);
                    // }

                    // if (debug) {
                    //     const m = world.derived.moistureAvailability[wIndex]; // assumed 0..1
                    //     // const m = world.derived.sstByLatitude[wIndex];
                    //     r = Math.round(m * 255);
                    //     g = 0;
                    //     b = 0;
                    // }
                    const [r, g, b] = this.viewColorAtWorldIndex(world, viewType, wIndex);

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
        // noWrap: true,
    }) as RecolorLayer;
    return layer;
}

import L from "leaflet"
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";


type TileRecord = {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    originalData: Uint8ClampedArray;
    coords: L.Coords;
};

type RecolorLayer = L.GridLayer & {
    setSeaLevel(t: number): void
    setIceLevel(t: number): void
};
type CanvasLayerCtor = new (opts?: L.GridLayerOptions) => RecolorLayer;

type ColorContext = {
    inputs: {
        originalData: Uint8ClampedArray;
        width: number;
        height: number;
        coords: L.Coords;
    };
    params: {
        seaLevel: number;
        iceLevel: number;
    };
    derived: {
        isLandMask: Uint8Array;          // 0 sea, 1 land
        heightAboveSea: Uint8Array;      // 0 for sea, else (elev - seaLevel)
        iceMask: Uint8Array;
    };
};


type MapProps = {
    waterLevel: number;
    iceLevel: number;
};

export default function TopographyMap({ waterLevel, iceLevel }: MapProps) {
    const mapRef = useRef<L.Map | null>(null);
    const layerRef = useRef<RecolorLayer | null>(null);

    function tileRowToLat(
        map: L.Map,
        coords: L.Coords,
        py: number,
        tileWidth: number,
        tileHeight: number
    ): number {
        const globalY = coords.y * tileHeight + py;
        return map.unproject(L.point(0, globalY), coords.z).lat;
    }


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


    useEffect(() => {
        const map = L.map("map", {
            center: [20, 0],
            zoom: 1,
            minZoom: 0,
            maxZoom: 3,
            worldCopyJump: true,
        });

        mapRef.current = map;

        let CanvasLayer = L.GridLayer.extend({
            _tileStore: new WeakMap<HTMLCanvasElement, TileRecord>(),
            seaLevel: 0,
            iceLevel: 0,

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
                    params: {
                        seaLevel: this.seaLevel,
                        iceLevel: this.iceLevel,
                    },
                    derived: {
                        isLandMask,
                        heightAboveSea: new Uint8Array(width * height),
                        iceMask: new Uint8Array(width * height),
                    },
                };
            },


            colorPixelsBySeaLevel: function (ctx: ColorContext) {
                const { originalData } = ctx.inputs;
                const { seaLevel } = ctx.params;
                const { isLandMask, heightAboveSea } = ctx.derived;

                for (let i = 0, p = 0; i < originalData.length; i += 4, p++) {
                    const elevation = originalData[i];

                    if (elevation < seaLevel) {
                        isLandMask[p] = 0;
                        heightAboveSea[p] = 0;
                    } else {
                        isLandMask[p] = 1;

                        // clamp because Uint8Array wraps on >255
                        const h = elevation - seaLevel;
                        heightAboveSea[p] = h > 255 ? 255 : h < 0 ? 0 : h;
                    }
                }
            },

            colorPixelsByIce: function (ctx: ColorContext) {
                const { width, height, coords } = ctx.inputs;
                const { iceLevel } = ctx.params;
                const { isLandMask, heightAboveSea, iceMask } = ctx.derived;

                const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
                const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

                if (!mapRef.current) return;
                const map = mapRef.current;

                const latitudeBiasExponent = 2;
                const elevationOfIce = 3000;
                const threshold = 1 - iceLevel;

                // Compute latitude for each pixel row once
                const latByRow = new Float32Array(height);
                for (let py = 0; py < height; py++) {
                    latByRow[py] = tileRowToLat(map, coords, py, width, height);
                }

                for (let p = 0; p < width * height; p++) {
                    const py = (p / width) | 0;          // row index
                    const latitude = latByRow[py];       // per-pixel latitude (via its row)

                    const latitudeWeighting = Math.pow(Math.abs(latitude) / 90, latitudeBiasExponent);

                    const elevation = heightAboveSea[p]; // 0 for sea, else elev - seaLevel
                    const elevationWeighting = clamp01(elevation / elevationOfIce);
                    const elevationModifier = 0.5;

                    const seaBias = 0.7;
                    const landBias = 1.0;
                    const landWeighting = lerp(seaBias, landBias, isLandMask[p]); // 0/1


                    const combined = clamp01(latitudeWeighting * (1 +  elevationModifier * elevationWeighting) * landWeighting);
                    iceMask[p] = combined > threshold ? 1 : 0;
                }
            },





            writeColorToPixels: function (ctx: ColorContext) {
                const { originalData, width, height } = ctx.inputs;
                const { seaLevel } = ctx.params;
                const { isLandMask, iceMask } = ctx.derived;

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

                    data[i] = r | 0;
                    data[i + 1] = g | 0;
                    data[i + 2] = b | 0;
                    data[i + 3] = 255;
                }

                return imageData;
            },


            colorPixels: function (ctx: ColorContext) {
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

                const tmsY = (1 << coords.z) - 1 - coords.y;
                img.src = `/tiles/${coords.z}/${coords.x}/${tmsY}.png`;

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

            // called by your React effect
            // rename setThreshold -> setSeaLevel
            setSeaLevel: function (newSeaLevel: number) {
                this.seaLevel = newSeaLevel;

                const tilesObj = (this as any)._tiles as Record<string, { el: HTMLElement }>;
                if (!tilesObj) return;

                Object.values(tilesObj).forEach(({ el }) => {
                    if (!(el instanceof HTMLCanvasElement)) return;

                    const rec = this._tileStore.get(el);
                    if (!rec) return;

                    const { ctx, width, height, originalData, coords } = rec;
                    const ctxObj: ColorContext = this.buildColorContext(originalData, width, height, coords);

                    ctxObj.params.seaLevel = newSeaLevel;
                    const colored = this.colorPixels(ctxObj);
                    ctx.putImageData(colored, 0, 0);
                });
            },

            setIceLevel: function (newIceLevel: number) {
                this.iceLevel = newIceLevel;
                
                const tilesObj = (this as any)._tiles as Record<string, { el: HTMLElement }>;
                if (!tilesObj) return;

                Object.values(tilesObj).forEach(({ el }) => {
                    if (!(el instanceof HTMLCanvasElement)) return;

                    const rec = this._tileStore.get(el);
                    if (!rec) return;

                    const { ctx, width, height, originalData, coords } = rec;
                    const ctxObj: ColorContext = this.buildColorContext(originalData, width, height, coords);

                    // set ice level
                    ctxObj.params.iceLevel = newIceLevel;

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




        const layer = new (CanvasLayer as unknown as CanvasLayerCtor)({ tileSize: 256 });
        layer.addTo(map);
        layerRef.current = layer;

        return () => {
            map.remove();
            mapRef.current = null;
            layerRef.current = null;
        };

    }, []);

    useEffect(() => {
        // use the var here (for now just proving it updates)
        layerRef.current?.setSeaLevel(waterLevel);
        // later you can trigger a layer redraw based on waterLevel
    }, [waterLevel]);

    useEffect(() => {
        // use the var here (for now just proving it updates)
        layerRef.current?.setIceLevel(iceLevel);
        // later you can trigger a layer redraw based on waterLevel
    }, [iceLevel]);

    return (
        <div className="h-full w-4/5 bg-white" id="map">

        </div>
    );
}
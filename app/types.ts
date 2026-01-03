export type WorldContext = {
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

export type RGB = readonly [number, number, number];

export enum VIEW_TYPE {
  LAND_SEA = "Land / Sea",
  LAND_SEA_ICE = "Land / Sea / Ice",
  MOISTURE_AVAILABILITY = "Moisture Availability",
  SST_BY_LATITUDE = "SST by Latitude",
}

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
    viewType: VIEW_TYPE;
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

import L from "leaflet"
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { createRecolorLayer, RecolorLayer, RecolorParams } from "./RecolorGridLayer";

type MapProps = {
    params: RecolorParams;
};

export default function TopographyMap({ params }: MapProps) {
    const mapRef = useRef<L.Map | null>(null);
    const layerRef = useRef<RecolorLayer | null>(null);

    useEffect(() => {
        const tileSize = 1024;
        const CRS512 = L.Util.extend({}, L.CRS.EPSG3857, {
            scale: (zoom: number) => tileSize * Math.pow(2, zoom),
            zoom: (scale: number) => Math.log(scale / tileSize) / Math.LN2,
        });
        const worldBounds = L.latLngBounds(
            L.latLng(-85.05112878, -180),
            L.latLng(85.05112878, 180)
        );

        const map = L.map("map", {
            center: [20, 0],
            zoom: 0,
            minZoom: 0,
            maxZoom: 3,
            worldCopyJump: false,
            crs: CRS512,
            // maxBounds: worldBound    s,
            maxBoundsViscosity: 1.0, // 1.0 = hard clamp, 0 = soft
        });

        mapRef.current = map;

        const layer = createRecolorLayer({
            getMap: () => mapRef.current,
            tileUrl: (coords) => {
                const tmsY = (1 << coords.z) - 1 - coords.y;
                return `/${process.env.NEXT_PUBLIC_TOPOGRAPHY_TILE_URL}/${coords.z}/${coords.x}/${tmsY}.png`;
            },
            initial: params,
            tileSize: tileSize
        });

        layer.addTo(map);
        layerRef.current = layer;

        map.on("click", (e) => {
            const layer = layerRef.current;
            if (!layer) return;

            const res = layer.getInfoAtPoint(e.latlng);
            if (!res) return;

            const html = `
  <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.35">
    <div><b>wIndex</b>: ${res.worldIndex} (gx=${res.gx}, gy=${res.gy})</div>
    <div><b>click lat/lng</b>: ${res.latlng.lat.toFixed(4)}, ${res.latlng.lng.toFixed(4)}</div>
    <div><b>world lat/lng</b>: ${res.worldLat.toFixed(4)}, ${res.worldLng.toFixed(4)}</div>

    <div><b>tile</b>: (${res.tile.x}, ${res.tile.y}, z=${res.tile.z}) px=(${res.tilePixel.x}, ${res.tilePixel.y})</div>
    <hr style="margin:6px 0" />

    <div><b>latitudeWeighting</b>: ${res.latitudeWeighting.toFixed(4)}</div>
    <div><b>elevationWeighting</b>: ${res.elevationWeighting.toFixed(4)} (h=${res.heightAboveSea})</div>
    <div><b>landWeighting</b>: ${res.landWeighting.toFixed(4)} (isLand=${res.isLand})</div>
    <div><b>sstByLatitude</b>: ${res.sstByLatitude.toFixed(4)}</div>
    <div><b>moistureAvailable</b>: ${res.moistureAvailable.toFixed(4)} (raw=${res.moistureAvailability.toFixed(4)})</div>
    <div><b>Continental Factor</b>: ${res.continentalFactor.toFixed(4)} (raw=${res.continentalValue.toFixed(4)})</div>

    <div><b>thermalGate</b>: ${res.thermalGate.toFixed(4)} (1=Tw<=0)</div>
    <div><b>effectiveAccumulation</b>: ${res.effectiveAccumulation.toFixed(4)}</div>

    <hr style="margin:6px 0" />

    <div><b>T_lat</b>: ${res.T_lat.toFixed(4)}</div>
    <div><b>T_elev</b>: ${res.T_elev.toFixed(4)}</div>
    <div><b>dT_global</b>: ${res.dT_global.toFixed(4)}</div>
    <div><b>T_mean</b>: ${res.T_mean.toFixed(4)}</div>
    <div><b>T_season</b>: ${res.T_season.toFixed(4)}</div>
    <div><b>T_cont</b>: ${res.T_cont.toFixed(4)} (continental01=${res.continental01.toFixed(4)})</div>

    <div><b>Tw</b>: ${res.Tw.toFixed(4)}</div>
    <div><b>Ts</b>: ${res.Ts.toFixed(4)}</div>

    <div><b>accum</b>: ${res.accum.toFixed(4)}</div>
    <div><b>iceSupply</b>: ${res.iceSupply.toFixed(4)}</div>
    <div><b>meltPressure</b>: ${res.meltPressure.toFixed(4)}</div>
    <div><b>melt</b>: ${res.melt.toFixed(4)}</div>
    <div><b>iceLeft</b>: ${res.iceLeft.toFixed(4)}</div>

    <hr style="margin:6px 0" />

    <div><b>combined</b>: ${res.combined.toFixed(4)}</div>
    <div><b>threshold</b>: ${res.threshold.toFixed(4)}</div>
    <div><b>ice</b>: ${res.ice ? "YES" : "no"}</div>
  </div>
`;


            L.popup()
                .setLatLng(e.latlng)
                .setContent(html)
                .openOn(map);
        });


        return () => {
            map.remove();
            mapRef.current = null;
            layerRef.current = null;
        };

    }, []);

    useEffect(() => {
        layerRef.current?.setParams(params);
    }, [params]);

    return (
        <div className="h-full w-full bg-white" id="map">
        </div>
    );
}
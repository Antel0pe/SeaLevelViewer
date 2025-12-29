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
        const map = L.map("map", {
            center: [20, 0],
            zoom: 2,
            minZoom: 0,
            maxZoom: 3,
            worldCopyJump: true,
        });

        mapRef.current = map;

        const layer = createRecolorLayer({
            getMap: () => mapRef.current,
            tileUrl: (coords) => {
                const tmsY = (1 << coords.z) - 1 - coords.y;
                return `/tiles/${coords.z}/${coords.x}/${tmsY}.png`;
            },
            initial: params,
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
<div>
  <b>wIndex</b>: ${res.worldIndex} (gx=${res.gx}, gy=${res.gy})
</div>
<div>
  <b>click lat/lng</b>: ${res.latlng.lat.toFixed(4)}, ${res.latlng.lng.toFixed(4)}
</div>
<div>
  <b>world lat/lng</b>: ${res.worldLat.toFixed(4)}, ${res.worldLng.toFixed(4)}
</div>

      <div><b>tile</b>: (${res.tile.x}, ${res.tile.y}, z=${res.tile.z}) px=(${res.tilePixel.x}, ${res.tilePixel.y})</div>
      <hr style="margin:6px 0" />
      <div><b>latitudeWeighting</b>: ${res.latitudeWeighting.toFixed(4)}</div>
      <div><b>elevationWeighting</b>: ${res.elevationWeighting.toFixed(4)} (h=${res.heightAboveSea})</div>
      <div><b>landWeighting</b>: ${res.landWeighting.toFixed(4)} (isLand=${res.isLand})</div>
      <div><b>moistureAvailable</b>: ${res.moistureAvailable.toFixed(4)} (raw=${res.moistureAvailability.toFixed(4)})</div>
            <div><b>Continental Factor</b>: ${res.continentalFactor.toFixed(4)} (raw=${res.continentalValue.toFixed(4)})</div>
            <div><b>thermalGate</b>: ${res.thermalGate.toFixed(4)}</div>
<div><b>effectiveAccumulation</b>: ${res.effectiveAccumulation.toFixed(4)}</div>

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
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
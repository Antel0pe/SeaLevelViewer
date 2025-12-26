// app/page.tsx (or wherever your Home component lives)
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { RecolorParams } from "./RecolorGridLayer";
import { Slider } from "./slider"

const Map = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

export default function Home() {
  const [params, setParams] = useState<RecolorParams>({
    seaLevel: 142,
    iceLevel: 0.33,

    latitudeBiasExponent: 2,
    elevationOfIce: 3000,
    seaBias: 0.7,
    landBias: 1.0,
    elevationModifier: 10.0,

    seaLevelDropDueToIce: 0.05,
    dryingOutExponent: 2,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);


  return (
    <div className="flex h-screen w-full">
      <div className="h-full w-4/5 bg-white">
        <Map params={params} />
      </div>

      <div className="h-full w-1/5 bg-black p-4 text-white" id="sliders">
        <Slider
          label={`Water level: ${params.seaLevel}`}
          min={0}
          max={255}
          value={params.seaLevel}
          onChange={(v) => setParams((p) => ({ ...p, seaLevel: v }))}
        />

        <Slider
          label={`Ice: ${Math.round(params.iceLevel * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          value={params.iceLevel}
          onChange={(v) => setParams((p) => ({ ...p, iceLevel: v }))}
        />

        <div className="mt-6 select-none">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="w-full flex items-center justify-between rounded bg-white/10 px-3 py-2 text-sm"
          >
            <span>Extra Settings</span>
            <span className="text-xs opacity-80">{showAdvanced ? "▲" : "▼"}</span>
          </button>

          {showAdvanced && (
            <div className="mt-4">
              <Slider
                label={`Latitude bias exponent: ${params.latitudeBiasExponent.toFixed(1)}`}
                min={0}
                max={6}
                step={0.1}
                value={params.latitudeBiasExponent}
                onChange={(v) =>
                  setParams((p) => ({ ...p, latitudeBiasExponent: v }))
                }
              />

              <Slider
                label={`Elevation of ice: ${Math.round(params.elevationOfIce)} m`}
                min={0}
                max={6000}
                step={50}
                value={params.elevationOfIce}
                onChange={(v) => setParams((p) => ({ ...p, elevationOfIce: v }))}
              />

              <Slider
                label={`Elevation modifier: ${params.elevationModifier.toFixed(1)}`}
                min={0}
                max={30}
                step={0.5}
                value={params.elevationModifier}
                onChange={(v) =>
                  setParams((p) => ({ ...p, elevationModifier: v }))
                }
              />

              <Slider
                label={`Sea bias: ${params.seaBias.toFixed(2)}`}
                min={0}
                max={1}
                step={0.01}
                value={params.seaBias}
                onChange={(v) => setParams((p) => ({ ...p, seaBias: v }))}
              />

              <Slider
                label={`Land bias: ${params.landBias.toFixed(2)}`}
                min={0}
                max={2}
                step={0.01}
                value={params.landBias}
                onChange={(v) => setParams((p) => ({ ...p, landBias: v }))}
              />

              <Slider
                label={`Sea level drop due to ice ${params.seaLevelDropDueToIce.toFixed(2)}`}
                min={0}
                max={1}
                step={0.01}
                value={params.seaLevelDropDueToIce}
                onChange={(v) => setParams((p) => ({ ...p, seaLevelDropDueToIce: v }))}
              />

              <Slider
                label={`Moisture drying out factor ${params.dryingOutExponent.toFixed(2)}`}
                min={0}
                max={5}
                step={0.1}
                value={params.dryingOutExponent}
                onChange={(v) => setParams((p) => ({ ...p, dryingOutExponent: v }))}
              />
            </div>
          )}
        </div>

      </div>

    </div>
  );
}

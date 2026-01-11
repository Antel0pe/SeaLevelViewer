// app/page.tsx (or wherever your Home component lives)
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Slider } from "./slider"
import { RecolorParams, VIEW_TYPE } from "./types";

const Map = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

export default function Home() {
  const [params, setParams] = useState<RecolorParams>({
    // --- Sea level / coastlines ---
    seaLevel: 142,
    iceLevel: 0.33,
    seaLevelDropDueToIce: 0.05,

    // --- Temperature structure (from your original constants) ---
    T_POLE: -25,
    lapseRate: 1.5,
    seasonalityStrength: 15,
    continentalSeasonBoost: 10,
    maxGlobalCooling: 18,

    // --- Moisture supply ---
    moistureScale: 1,

    // --- Continental scaling (keep original default) ---
    continentalScale: 1.0,

    // --- Dryness / transport (from your original constants) ---
    continentalDryness: 0.5,
    mountainRainout: 0.1,
    coastalThreshold: 0.5,
    vaporLatitudeExponent: 1.5,

    // --- Rendering / debug ---
    viewType: VIEW_TYPE.LAND_SEA_ICE,
  });

  const [showAdvanced, setShowAdvanced] = useState(false);


  return (
  <div className="flex h-screen w-full">
    <div className="h-full w-4/5 bg-white">
      <Map params={params} />
    </div>

    <div
      className="h-full w-1/5 bg-black p-4 text-white overflow-y-auto "
      id="sliders"
    >
      <div className="mb-4">
        <div className="mb-2 text-sm opacity-90">View</div>
        <select
          className="w-full rounded bg-white/10 px-3 py-2 text-sm text-white outline-none"
          value={params.viewType}
          onChange={(e) =>
            setParams((p) => ({ ...p, viewType: e.target.value as VIEW_TYPE }))
          }
        >
          {(Object.values(VIEW_TYPE) as VIEW_TYPE[]).map((v) => (
            <option key={v} value={v} className="bg-black text-white">
              {v}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 text-sm opacity-90">Config</div>

      {/* Normal */}
      <Slider
        label={`Sea level: ${params.seaLevel}`}
        min={0}
        max={255}
        value={params.seaLevel}
        onChange={(v) => setParams((p) => ({ ...p, seaLevel: v }))}
      />

      <Slider
        label={`Temperature drop due to elevation: ${params.lapseRate.toFixed(2)} °/km`}
        min={0}
        max={8}
        step={0.1}
        value={params.lapseRate}
        onChange={(v) => setParams((p) => ({ ...p, lapseRate: v }))}
      />

      <Slider
        label={`Seasonality Swing: ${params.seasonalityStrength.toFixed(1)}`}
        min={0}
        max={30}
        step={0.5}
        value={params.seasonalityStrength}
        onChange={(v) =>
          setParams((p) => ({ ...p, seasonalityStrength: v }))
        }
      />

      <Slider
        label={`Continental season boost: ${params.continentalSeasonBoost.toFixed(1)}`}
        min={0}
        max={25}
        step={0.5}
        value={params.continentalSeasonBoost}
        onChange={(v) =>
          setParams((p) => ({ ...p, continentalSeasonBoost: v }))
        }
      />

      <Slider
  label={`Global Cooling: ${(params.iceLevel * params.maxGlobalCooling).toFixed(1)}°`}
  min={0}
  max={30}
  step={0.5}
  value={params.maxGlobalCooling}
  onChange={(v) => setParams((p) => ({ ...p, maxGlobalCooling: v }))}
 />


      <Slider
        label={`Coastal land threshold: ${params.coastalThreshold.toFixed(2)}`}
        min={0}
        max={0.95}
        step={0.01}
        value={params.coastalThreshold}
        onChange={(v) => setParams((p) => ({ ...p, coastalThreshold: v }))}
      />

      {/* Advanced */}
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
            {/* 
              <Slider
                label={`Sea level drop due to ice: ${params.seaLevelDropDueToIce.toFixed(2)}`}
                min={0}
                max={0.2}
                step={0.005}
                value={params.seaLevelDropDueToIce}
                onChange={(v) => setParams((p) => ({ ...p, seaLevelDropDueToIce: v }))}
              /> */}

            <Slider
              label={`Coldest Polar Temperature: ${params.T_POLE.toFixed(1)}°`}
              min={-50}
              max={-5}
              step={0.5}
              value={params.T_POLE}
              onChange={(v) => setParams((p) => ({ ...p, T_POLE: v }))}
            />

            <Slider
              label={`Moisture scale: ${params.moistureScale.toFixed(2)}`}
              min={0}
              max={3}
              step={0.01}
              value={params.moistureScale}
              onChange={(v) => setParams((p) => ({ ...p, moistureScale: v }))}
            />

            <Slider
              label={`Continental factor scale: ${params.continentalScale.toFixed(2)}`}
              min={0}
              max={3}
              step={0.01}
              value={params.continentalScale}
              onChange={(v) =>
                setParams((p) => ({ ...p, continentalScale: v }))
              }
            />

            <Slider
              label={`Continental dryness: ${params.continentalDryness.toFixed(2)}`}
              min={0}
              max={1.5}
              step={0.01}
              value={params.continentalDryness}
              onChange={(v) =>
                setParams((p) => ({ ...p, continentalDryness: v }))
              }
            />

            <Slider
              label={`Mountain rainshadow: ${params.mountainRainout.toFixed(3)}`}
              min={0}
              max={0.5}
              step={0.005}
              value={params.mountainRainout}
              onChange={(v) =>
                setParams((p) => ({ ...p, mountainRainout: v }))
              }
            />

            {/* <Slider
              label={`Tropical Moisture Concentration: ${params.vaporLatitudeExponent.toFixed(2)}`}
              min={0.2}
              max={4}
              step={0.05}
              value={params.vaporLatitudeExponent}
              onChange={(v) => setParams((p) => ({ ...p, vaporLatitudeExponent: v }))}
            /> */}
          </div>
        )}
      </div>
    </div>
  </div>
);


}

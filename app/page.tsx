// app/page.tsx (or wherever your Home component lives)
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

const Map = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <p>Loading map...</p>,
});

export default function Home() {
  const [waterLevel, setWaterLevel] = useState<number>(0);
  const [iceLevel, setIceLevel] = useState<number>(0);

  return (
    <div className="flex h-screen w-full">
      <Map waterLevel={waterLevel} iceLevel={iceLevel} />

      <div className="h-full w-1/5 bg-black p-4 text-white" id="sliders">
        <div className="mb-6">
          <div className="text-sm mb-2">Water level: {waterLevel}</div>
          <input
            type="range"
            min={0}
            max={255}
            value={waterLevel}
            onChange={(e) => setWaterLevel(Number(e.target.value))}
            className="w-full"
          />
        </div>

        <div>
          <div className="text-sm mb-2">
            Ice: {Math.round(iceLevel * 100)}%
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={iceLevel}
            onChange={(e) => setIceLevel(Number(e.target.value))}
            className="w-full"
          />


        </div>
      </div>
    </div>
  );
}

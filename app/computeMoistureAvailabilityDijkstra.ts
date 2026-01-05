import { MoistureDijkstraResult } from "./types";

export type Dir4 = 0 | 1 | 2 | 3;

export type MoistureDijkstraParams = {
  pixelKm?: number; // default 50
  L0Km?: number; // default 6900
  oceanStepCost?: number; // default 1e-4 (>=0)
  landBaseMultiplier?: number; // default 1.0
  coldMultiplier?: (p: number) => number; // >=1
  elevationPenalty?: (u: number, v: number, dir: Dir4) => number; // >=0
  directionPenalty?: (u: number, v: number, dir: Dir4) => number; // >=0
  treatDiagonal?: false;
};

function clampNonNeg(x: number) { return x < 0 ? 0 : x; }
function clampAtLeast1(x: number) { return x < 1 ? 1 : x; }
function clampSourceStrength(x: number, eps: number) {
  if (!Number.isFinite(x) || x <= eps) return eps;
  if (x >= 1) return 1;
  return x;
}

class MinHeapPair {
  // stores parallel arrays of (node, key)
  nodes: number[] = [];
  keys: number[] = [];

  size() { return this.nodes.length; }

  push(node: number, key: number) {
    let i = this.nodes.length;
    this.nodes.push(node);
    this.keys.push(key);

    // sift up
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      // swap i <-> p
      this.nodes[i] = this.nodes[p];
      this.keys[i] = this.keys[p];
      this.nodes[p] = node;
      this.keys[p] = key;
      i = p;
    }
  }

  pop(): { node: number; key: number } | null {
    const n = this.nodes.length;
    if (n === 0) return null;

    const outNode = this.nodes[0];
    const outKey = this.keys[0];

    const lastNode = this.nodes.pop()!;
    const lastKey = this.keys.pop()!;
    if (n > 1) {
      this.nodes[0] = lastNode;
      this.keys[0] = lastKey;

      // sift down
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        if (l >= this.nodes.length) break;

        let m = l;
        if (r < this.nodes.length && this.keys[r] < this.keys[l]) m = r;

        if (this.keys[i] <= this.keys[m]) break;

        // swap i <-> m
        const tn = this.nodes[i]; this.nodes[i] = this.nodes[m]; this.nodes[m] = tn;
        const tk = this.keys[i]; this.keys[i] = this.keys[m]; this.keys[m] = tk;

        i = m;
      }
    }

    return { node: outNode, key: outKey };
  }
}

export function computeMoistureAvailabilityDijkstra(
  isLand: Uint8Array | Uint8ClampedArray,
  sourceStrength: Float32Array,
  width: number,
  height: number,
  params: MoistureDijkstraParams = {}
): MoistureDijkstraResult {
  const N = width * height;
  if (isLand.length !== N) throw new Error(`isLand length ${isLand.length} != ${N}`);
  if (sourceStrength.length !== N) throw new Error(`sourceStrength length ${sourceStrength.length} != ${N}`);

  const pixelKm = params.pixelKm ?? 50;
  const L0Km = params.L0Km ?? 3000;
  // const oceanStepCost = clampNonNeg(params.oceanStepCost ?? 1e-4);
  const oceanStepCost = 0.001;
  const landBaseMultiplier = params.landBaseMultiplier ?? 1.0;

  const safeL0 = L0Km > 0 ? L0Km : 1;
  const baselineLandStep = (pixelKm / safeL0) * landBaseMultiplier;

  const coldMultiplier = params.coldMultiplier;
  const elevationPenalty = params.elevationPenalty;
  const directionPenalty = params.directionPenalty;

  const eps = 1e-6;

  // Use Float64Array for cost: fast + avoids float32 mismatch
  const cost = new Float64Array(N);
  for (let i = 0; i < N; i++) cost[i] = Infinity;

  const prev = new Int32Array(N);
  const src = new Int32Array(N);
  for (let i = 0; i < N; i++) { prev[i] = -1; src[i] = -1; }

  const heap = new MinHeapPair();

  // Multi-source init (ocean pixels)
  for (let p = 0; p < N; p++) {
    if (isLand[p] !== 0) continue; // ocean only
    const s = clampSourceStrength(sourceStrength[p], eps);
    const c0 = -Math.log(s);
    cost[p] = c0;
    prev[p] = -1;
    src[p] = p;        // this ocean pixel is its own source
    heap.push(p, c0);
  }

  const stepCostTo = (u: number, v: number, dir: Dir4): number => {
    // if (isLand[v] === 0) return oceanStepCost;
    const isOcean = (isLand[v] === 0);

    let c = isOcean ? oceanStepCost : baselineLandStep;
    if (coldMultiplier) c *= clampAtLeast1(coldMultiplier(v));
    if (elevationPenalty) c += clampNonNeg(elevationPenalty(u, v, dir));
    if (directionPenalty) c += clampNonNeg(directionPenalty(u, v, dir));
    return c < 0 ? 0 : c;
  };

  while (heap.size() > 0) {
    const it = heap.pop()!;
    const u = it.node;
    const cu = it.key;

    // stale (use >, not !==)
    if (cu > cost[u]) continue;

    const x = u % width;
    const y = (u / width) | 0;

    // east
    if (x + 1 < width) {
      const v = u + 1;
      const nv = cu + stepCostTo(u, v, 0);
      if (nv < cost[v]) {
        cost[v] = nv;
        prev[v] = u;
        src[v] = src[u];   // inherit ultimate source
        heap.push(v, nv);
      }
    }
    // west
    if (x - 1 >= 0) {
      const v = u - 1;
      const nv = cu + stepCostTo(u, v, 1);
      if (nv < cost[v]) {
        cost[v] = nv;
        prev[v] = u;
        src[v] = src[u];   // inherit ultimate source
        heap.push(v, nv);
      }
    }
    // south
    if (y + 1 < height) {
      const v = u + width;
      const nv = cu + stepCostTo(u, v, 2);
      if (nv < cost[v]) {
        cost[v] = nv;
        prev[v] = u;
        src[v] = src[u];   // inherit ultimate source
        heap.push(v, nv);
      }
    }
    // north
    if (y - 1 >= 0) {
      const v = u - width;
      const nv = cu + stepCostTo(u, v, 3);
      if (nv < cost[v]) {
        cost[v] = nv;
        prev[v] = u;
        src[v] = src[u];   // inherit ultimate source
        heap.push(v, nv);
      }
    }
  }

  const moisture = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const c = cost[p];
    moisture[p] = Number.isFinite(c) ? Math.exp(-c) : 0;
  }
  return { moisture, src, prev, cost };
}

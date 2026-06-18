// app/src/dream/layerPlan.ts
// Pure mapping from intensity (0..1) to a compositing recipe. The LayerStack renders this;
// keeping it pure makes the density logic unit-testable without a GPU.

import type { Rng } from './prng';

export const MAX_LAYERS = 8;
export type BlendName = 'normal' | 'screen' | 'lighten' | 'multiply' | 'overlay';
const BLENDS: BlendName[] = ['screen', 'lighten', 'multiply', 'overlay', 'screen'];

export interface LayerPlan {
  layerCount: number;
  feedback: number; // 0..1 trail strength
  warp: number; // 0..1 displacement strength
  blends: BlendName[]; // length === layerCount; first layer is always 'normal' base
}

export function planLayers(intensity: number, rng: Rng): LayerPlan {
  const x = Math.max(0, Math.min(1, intensity));
  let layerCount: number;
  if (x < 0.22) layerCount = 1 + rng.int(3); // band A: 1..3
  else if (x < 0.66) layerCount = 4 + rng.int(3); // band B: 4..6
  else layerCount = 7 + rng.int(MAX_LAYERS - 6); // band C: 7..MAX
  layerCount = Math.min(MAX_LAYERS, layerCount);

  const feedback = Math.min(1, 0.1 + x * 0.85);
  const warp = Math.min(1, x * x * 0.9); // warp ramps in only as it gets wild

  const blends: BlendName[] = ['normal'];
  for (let i = 1; i < layerCount; i++) blends.push(BLENDS[rng.int(BLENDS.length)]);
  return { layerCount, feedback, warp, blends };
}

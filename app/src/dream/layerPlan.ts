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
  if (x < 0.66) layerCount = 1;
  else if (x < 0.9) layerCount = 2;
  else layerCount = 2 + rng.int(2);
  layerCount = Math.min(MAX_LAYERS, layerCount);

  const feedback = x < 0.82 ? 0 : Math.min(0.18, (x - 0.82) * 0.75);
  const warp = Math.min(0.35, x * x * 0.35);

  const blends: BlendName[] = ['normal'];
  for (let i = 1; i < layerCount; i++) blends.push(BLENDS[rng.int(BLENDS.length)]);
  return { layerCount, feedback, warp, blends };
}

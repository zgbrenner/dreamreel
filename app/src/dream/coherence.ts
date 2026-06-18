// app/src/dream/coherence.ts
// What surfaces during a coherence trough. Deterministic per (seed, troughId): 50% thematic
// rhyme, 35% lucid single image, 15% legible phrase. Pure — no DOM, no three.js.

import { makeRng } from './prng';

export type CoherenceKind = 'rhyme' | 'lucid' | 'phrase';

export function coherenceForTrough(seed: string, troughId: number): CoherenceKind {
  const r = makeRng(`${seed}:coh:${troughId}`).next();
  if (r < 0.5) return 'rhyme';
  if (r < 0.85) return 'lucid';
  return 'phrase';
}

// app/src/dream/coherence.ts
// What surfaces during a coherence trough. Deterministic per (seed, troughId): 50% thematic
// rhyme, 32% lucid single image, 10% legible phrase, 8% FALSE AWAKENING — the trough overshoots
// into a clean, treatment-free "am I awake?" moment before the dream pulls back under (a classic
// dream phenomenon; the conductor drops the film grade/filters to near-zero for its duration).
// Pure — no DOM, no three.js.

import { makeRng } from './prng';

export type CoherenceKind = 'rhyme' | 'lucid' | 'phrase' | 'awake';

export function coherenceForTrough(seed: string, troughId: number): CoherenceKind {
  const r = makeRng(`${seed}:coh:${troughId}`).next();
  if (r < 0.5) return 'rhyme';
  if (r < 0.82) return 'lucid';
  if (r < 0.92) return 'phrase';
  return 'awake';
}

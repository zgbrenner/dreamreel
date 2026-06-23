// app/src/dream/seedParams.ts
// The dream's surreality and tempo used to be user knobs. They are now INTERNAL: derived
// deterministically from the seed, so each new dream gets its own character — one seed is
// calm, another frenzied — and variety lives ACROSS dreams rather than in on-screen controls.
// Same seed → same params → same dream (the determinism contract).

import { makeRng } from './prng';

export interface SeedParams {
  /** 0..1 — softmax temperature + leap probability of the Dreamwalker. */
  surreality: number;
  /** 0.5..2 — playback pacing multiplier. */
  tempo: number;
}

/**
 * Derive (surreality, tempo) from a seed. Uses a dedicated `:params` prng stream so the values
 * are independent of — and don't perturb — the walk/presentation streams keyed off the same seed.
 */
export function deriveSeedParams(seed: string): SeedParams {
  const rng = makeRng(`${seed}:params`);
  const surreality = rng.next(); // full 0..1 spread
  const tempo = 0.5 + rng.next() * 1.5; // 0.5..2
  return { surreality, tempo };
}

// app/src/dream/prng.ts
// The single source of randomness in the dream path. Any non-seeded Math.random() would
// break shareable seeds, so everything stochastic routes through here.

/** Hash a string seed to a 32-bit integer (xmur3). */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Standard normal sample (Box–Muller). */
  gaussian(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** A child stream, deterministically derived from this one's current state. */
  fork(tag: string): Rng;
}

/** mulberry32 — small, fast, good enough for procedural drift; fully seedable. */
export function makeRng(seed: string | number): Rng {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  let spare: number | null = null;

  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const gaussian = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mag = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mag;
    return u * mag;
  };

  const rng: Rng = {
    next,
    gaussian,
    int: (n: number) => Math.floor(next() * n),
    fork: (tag: string) => makeRng((a >>> 0) ^ hashSeed(tag)),
  };
  return rng;
}

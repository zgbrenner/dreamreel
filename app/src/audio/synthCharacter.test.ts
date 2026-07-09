import { describe, it, expect } from 'vitest';
import {
  deriveSynthCharacter,
  DEFAULT_SYNTH_CHARACTER,
  type SynthCharacter,
} from './params';

// Allowed value sets/ranges — the bounded palette every dream must stay inside.
const OSC = new Set(['sine', 'triangle', 'sawtooth', 'square']);
const FILTERS = new Set(['lowpass', 'bandpass', 'highpass']);
const LFO = new Set(['sine', 'triangle', 'sawtooth', 'square']);
const NOISE = new Set(['white', 'pink', 'brown']);
const INTERVALS = [1.2, 1.25, 1.3333, 1.4142, 1.5, 1.6, 2.0];

function seeds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `seed-${i}-${(i * 2654435761) >>> 0}`);
}

function inRange(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi;
}

describe('deriveSynthCharacter', () => {
  it('is deterministic: same seed -> identical character, stable across calls', () => {
    const a = deriveSynthCharacter('midnight-owl');
    const b = deriveSynthCharacter('midnight-owl');
    const c = deriveSynthCharacter('midnight-owl');
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // Distinct object each call (no shared mutable reference).
    expect(a).not.toBe(b);
  });

  it('empty / whitespace seed reproduces the default (legacy) bed', () => {
    expect(deriveSynthCharacter('')).toEqual(DEFAULT_SYNTH_CHARACTER);
    expect(deriveSynthCharacter('   ')).toEqual(DEFAULT_SYNTH_CHARACTER);
    // Returns a fresh copy, not the frozen singleton reference.
    expect(deriveSynthCharacter('')).not.toBe(DEFAULT_SYNTH_CHARACTER);
    // The legacy values that engine.ts's original build() used, pinned so we never regress them.
    expect(DEFAULT_SYNTH_CHARACTER).toMatchObject({
      oscAType: 'sine',
      oscBType: 'triangle',
      bellType: 'sine',
      intervalRatio: 1.5,
      detuneSpread: 0,
      droneGain: 0.22,
      filterType: 'lowpass',
      filterQ: 1,
      cutoffScale: 1,
      lfoType: 'sine',
      lfoRateHz: 0.05,
      lfoMin: 320,
      lfoMax: 900,
      noiseColor: 'pink',
      reverbDecay: 7,
    });
  });

  it('different seeds produce different characters', () => {
    const list = seeds(48);
    const serialized = new Set(list.map((s) => JSON.stringify(deriveSynthCharacter(s))));
    // The bounded palette still spreads seeds across many distinct rooms.
    expect(serialized.size).toBeGreaterThan(30);
    // Two hand-picked distinct seeds are architecturally different.
    expect(deriveSynthCharacter('alpha')).not.toEqual(deriveSynthCharacter('omega'));
  });

  it('every field stays inside its bounded palette / range', () => {
    for (const s of seeds(200)) {
      const c: SynthCharacter = deriveSynthCharacter(s);
      expect(OSC.has(c.oscAType)).toBe(true);
      expect(OSC.has(c.oscBType)).toBe(true);
      expect(OSC.has(c.bellType)).toBe(true);
      expect(INTERVALS).toContain(c.intervalRatio);
      expect(inRange(c.detuneSpread, 0, 14)).toBe(true);
      expect(inRange(c.droneGain, 0.16, 0.26)).toBe(true);
      expect(FILTERS.has(c.filterType)).toBe(true);
      expect(inRange(c.filterQ, 0.7, 2)).toBe(true);
      expect(inRange(c.cutoffScale, 0.8, 1.3)).toBe(true);
      expect(LFO.has(c.lfoType)).toBe(true);
      expect(inRange(c.lfoRateHz, 0.03, 0.09)).toBe(true);
      expect(c.lfoMin).toBeGreaterThanOrEqual(180);
      expect(c.lfoMax).toBeGreaterThan(c.lfoMin);
      expect(inRange(c.lfoMax, LFO_max_lo(), LFO_max_hi())).toBe(true);
      expect(NOISE.has(c.noiseColor)).toBe(true);
      expect(inRange(c.reverbDecay, 5, 10)).toBe(true);
    }
  });
});

// LFO max = 610 + halfSpan, halfSpan in [200, 380] -> [810, 990].
function LFO_max_lo(): number {
  return 810;
}
function LFO_max_hi(): number {
  return 990;
}

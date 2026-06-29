// app/src/dream/memory.test.ts
//
// DreamMemory is the heart of dream RECURRENCE: a decaying weighted set of the entities the dream
// has surfaced. Its whole contract is "pure + deterministic" — same observed-entity sequence and
// per-beat decay yields the same memory, bit-for-bit — and BOUNDED + RELAXING (capped per entity,
// decays every beat). These tests pin that contract so the recurrence tuning can't silently drift.

import { describe, it, expect } from 'vitest';
import { DreamMemory, DEFAULT_MEMORY_CONFIG, type DreamMemoryConfig } from './memory';

// A config with exact, easy-to-reason-about arithmetic for threshold tests.
const EXACT: DreamMemoryConfig = {
  addWeight: 1.0,
  decay: 0.5,
  cap: 3.0,
  prune: 0.1,
  maxEntities: 3,
};

describe('DreamMemory — observe + cap', () => {
  it('observe adds addWeight, and repeated observation saturates at cap (no fixation)', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['clock']);
    expect(m.weightOf('clock')).toBe(1.0);
    m.observe(['clock']);
    expect(m.weightOf('clock')).toBe(2.0);
    // Keep observing — it must clamp at cap, never run away.
    for (let i = 0; i < 10; i++) m.observe(['clock']);
    expect(m.weightOf('clock')).toBe(EXACT.cap);
  });

  it('ignores empty / undefined entity lists', () => {
    const m = new DreamMemory(EXACT);
    m.observe(undefined);
    m.observe([]);
    expect(m.size()).toBe(0);
  });

  it('an unremembered entity has weight 0', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['moon']);
    expect(m.weightOf('staircase')).toBe(0);
  });
});

describe('DreamMemory — decay + prune (it relaxes)', () => {
  it('decayStep multiplies every weight by decay', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['bird']);
    m.decayStep();
    expect(m.weightOf('bird')).toBe(0.5); // 1.0 * 0.5
    m.decayStep();
    expect(m.weightOf('bird')).toBe(0.25); // 0.5 * 0.5
  });

  it('a weight that decays below prune is forgotten entirely', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['hands']); // 1.0
    m.decayStep(); // 0.5
    m.decayStep(); // 0.25
    m.decayStep(); // 0.125 — still >= prune (0.1)
    expect(m.weightOf('hands')).toBeCloseTo(0.125, 6);
    expect(m.size()).toBe(1);
    m.decayStep(); // 0.0625 < prune -> forgotten
    expect(m.weightOf('hands')).toBe(0);
    expect(m.size()).toBe(0);
  });

  it('a motif observed once with the DEFAULT config is mostly gone after ~5–6 beats (documented)', () => {
    // The documented intent of decay 0.82: a single observation fades to ~half in ~6 beats.
    const m = new DreamMemory();
    m.observe(['lantern']);
    for (let i = 0; i < 6; i++) m.decayStep();
    expect(m.weightOf('lantern')).toBeCloseTo(Math.pow(DEFAULT_MEMORY_CONFIG.decay, 6), 6);
    expect(m.weightOf('lantern')).toBeLessThan(0.5); // "mostly gone"
  });
});

describe('DreamMemory — echo (the recurrence currency)', () => {
  it('echo sums the memory weights of a candidate’s entities', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['clock', 'moon']); // both 1.0
    m.observe(['clock']); // clock -> 2.0
    expect(m.echo(['clock'])).toBe(2.0);
    expect(m.echo(['clock', 'moon'])).toBe(3.0);
    expect(m.echo(['moon', 'unseen'])).toBe(1.0); // unseen contributes 0
  });

  it('echo is 0 when memory is empty or the candidate carries no entities', () => {
    const m = new DreamMemory(EXACT);
    expect(m.echo(['clock'])).toBe(0); // empty memory
    m.observe(['clock']);
    expect(m.echo(undefined)).toBe(0);
    expect(m.echo([])).toBe(0);
    expect(m.echo(['nothing'])).toBe(0);
  });
});

describe('DreamMemory — dominant (deterministic tie-break)', () => {
  it('returns the strongest entity, breaking ties by name', () => {
    const m = new DreamMemory(EXACT);
    expect(m.dominant()).toBeUndefined();
    m.observe(['zebra']);
    m.observe(['apple']);
    m.observe(['apple']); // apple 2.0 > zebra 1.0
    expect(m.dominant()).toBe('apple');
    // Make them tie, then the alphabetically-first name wins (deterministic).
    m.observe(['zebra']); // zebra -> 2.0, tie with apple
    expect(m.dominant()).toBe('apple');
  });
});

describe('DreamMemory — bounded set size', () => {
  it('keeps only the strongest maxEntities, dropping the rest deterministically', () => {
    const m = new DreamMemory(EXACT); // maxEntities = 3
    // Give a clear ranking: d=3, c=2, then four 1.0 ties (e,f,g,h).
    m.observe(['d']);
    m.observe(['d']);
    m.observe(['d']);
    m.observe(['c']);
    m.observe(['c']);
    m.observe(['e', 'f', 'g', 'h']); // pushes size over 3 in one beat
    expect(m.size()).toBe(3);
    // The two strongest survive...
    expect(m.weightOf('d')).toBe(3.0);
    expect(m.weightOf('c')).toBe(2.0);
    // ...and among the 1.0 ties, the alphabetically-first ('e') takes the last slot.
    expect(m.weightOf('e')).toBe(1.0);
    expect(m.weightOf('f')).toBe(0);
    expect(m.weightOf('g')).toBe(0);
    expect(m.weightOf('h')).toBe(0);
  });
});

describe('DreamMemory — determinism + lifecycle', () => {
  it('the conductor beat order (decayStep THEN observe) is reproducible from the entity sequence', () => {
    const beats: string[][] = [['clock'], ['moon'], ['clock', 'bird'], ['moon'], ['clock']];
    const run = (): Record<string, number> => {
      const m = new DreamMemory(EXACT);
      for (const entities of beats) {
        m.decayStep(); // conductor.observeMemory order
        m.observe(entities);
      }
      return m.snapshot();
    };
    expect(run()).toEqual(run()); // identical, run-to-run
  });

  it('reset clears all memory', () => {
    const m = new DreamMemory(EXACT);
    m.observe(['clock', 'moon']);
    expect(m.size()).toBe(2);
    m.reset();
    expect(m.size()).toBe(0);
    expect(m.weightOf('clock')).toBe(0);
    expect(m.snapshot()).toEqual({});
  });
});

describe('DreamMemory — the default config matches its documented values', () => {
  it('DEFAULT_MEMORY_CONFIG is the tuned baseline', () => {
    expect(DEFAULT_MEMORY_CONFIG).toEqual({
      addWeight: 1.0,
      decay: 0.82,
      cap: 2.5,
      prune: 0.06,
      maxEntities: 48,
    });
  });
});

import { describe, it, expect } from 'vitest';
import { DreamMemory, type DreamMemoryConfig } from '../../src/dream/memory';

const cfg: DreamMemoryConfig = { addWeight: 1, decay: 0.5, cap: 2, prune: 0.1, maxEntities: 3 };

describe('DreamMemory', () => {
  it('observe accumulates weight; echo sums the overlap with current memory', () => {
    const m = new DreamMemory(cfg);
    m.observe(['clock', 'bird']);
    expect(m.echo(['clock'])).toBe(1);
    expect(m.echo(['clock', 'bird'])).toBe(2);
    expect(m.echo(['moon'])).toBe(0); // unremembered entity
    expect(m.echo(undefined)).toBe(0); // asset with no entities
  });

  it('caps per-entity weight so a single motif never fixates', () => {
    const m = new DreamMemory(cfg);
    for (let i = 0; i < 10; i++) m.observe(['clock']);
    expect(m.echo(['clock'])).toBe(2); // cap
  });

  it('decays each beat and forgets faint motifs', () => {
    const m = new DreamMemory(cfg);
    m.observe(['clock']); // 1.0
    m.decayStep();
    expect(m.echo(['clock'])).toBe(0.5);
    m.decayStep(); // 0.25
    m.decayStep(); // 0.125
    m.decayStep(); // 0.0625 < prune 0.1 → forgotten
    expect(m.echo(['clock'])).toBe(0);
    expect(m.size()).toBe(0);
  });

  it('dominant returns the strongest remembered entity', () => {
    const m = new DreamMemory(cfg);
    m.observe(['a', 'b']);
    m.observe(['b']); // a=1, b=2
    expect(m.dominant()).toBe('b');
  });

  it('bounds memory to maxEntities, keeping the strongest (deterministic tie-break)', () => {
    const m = new DreamMemory(cfg);
    m.observe(['a']);
    m.observe(['a']); // a=2
    m.observe(['b']); // b=1
    m.observe(['c', 'd', 'e']); // size would be 5 → keep top 3: a(2), then b,c by name
    expect(m.size()).toBe(3);
    expect(m.echo(['a'])).toBe(2);
    expect(m.echo(['d'])).toBe(0); // dropped
    expect(m.echo(['e'])).toBe(0); // dropped
  });

  it('is deterministic for the same observe/decay sequence', () => {
    const run = () => {
      const m = new DreamMemory(cfg);
      m.observe(['x', 'y']);
      m.decayStep();
      m.observe(['y']);
      return m.snapshot();
    };
    expect(run()).toEqual(run());
  });

  it('reset clears all memory', () => {
    const m = new DreamMemory(cfg);
    m.observe(['a', 'b']);
    m.reset();
    expect(m.size()).toBe(0);
    expect(m.echo(['a'])).toBe(0);
  });
});

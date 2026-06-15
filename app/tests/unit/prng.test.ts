import { describe, it, expect } from 'vitest';
import { makeRng, hashSeed } from '../../src/dream/prng';

describe('makeRng — determinism', () => {
  it('same seed yields an identical stream', () => {
    const a = makeRng('reel-7');
    const b = makeRng('reel-7');
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('numeric and string seeds are both accepted and stable', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 10 }, () => a.next())).toEqual(
      Array.from({ length: 10 }, () => b.next()),
    );
  });

  it('different seeds diverge', () => {
    const a = makeRng('seed-a');
    const b = makeRng('seed-b');
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('makeRng — next() range', () => {
  it('stays within [0, 1)', () => {
    const r = makeRng('range');
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform (mean ~0.5)', () => {
    const r = makeRng('uniform');
    let sum = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) sum += r.next();
    expect(sum / n).toBeCloseTo(0.5, 2);
  });
});

describe('makeRng — int(n)', () => {
  it('returns integers in [0, n)', () => {
    const r = makeRng('int');
    for (let i = 0; i < 10000; i++) {
      const v = r.int(7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('covers the whole range over enough draws', () => {
    const r = makeRng('coverage');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(r.int(5));
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});

describe('makeRng — gaussian()', () => {
  it('has mean ~0 and variance ~1', () => {
    const r = makeRng('gauss');
    const n = 200000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const g = r.gaussian();
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(0, 1);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
  });

  it('is deterministic for a given seed', () => {
    const a = makeRng('g');
    const b = makeRng('g');
    expect(Array.from({ length: 50 }, () => a.gaussian())).toEqual(
      Array.from({ length: 50 }, () => b.gaussian()),
    );
  });
});

describe('makeRng — fork(tag)', () => {
  it('produces a deterministic child stream', () => {
    const a = makeRng('parent').fork('child');
    const b = makeRng('parent').fork('child');
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it('different tags give independent streams', () => {
    const parent = makeRng('parent');
    const childX = parent.fork('x');
    const childY = parent.fork('y');
    const x = Array.from({ length: 20 }, () => childX.next());
    const y = Array.from({ length: 20 }, () => childY.next());
    expect(x).not.toEqual(y);
  });
});

describe('hashSeed', () => {
  it('is stable and returns an unsigned 32-bit integer', () => {
    const h = hashSeed('dreamreel');
    expect(h).toBe(hashSeed('dreamreel'));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('differs for different inputs', () => {
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});

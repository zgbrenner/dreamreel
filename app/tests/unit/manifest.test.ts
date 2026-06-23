import { describe, it, expect } from 'vitest';
import { parseManifest, ManifestError } from '../../src/manifest/loader';
import { MOOD_AXES } from '../../src/manifest/types';
import seed from '../../public/manifest.seed.json';

describe('manifest validation', () => {
  it('accepts the seed manifest', () => {
    const m = parseManifest(seed);
    expect(m.assets.length).toBeGreaterThan(0);
    expect(m.embeddingDim).toBe(8);
  });

  it('every asset, text, and audio mood carries a value for EVERY emotional axis', () => {
    const m = parseManifest(seed);
    const sortedAxes = [...MOOD_AXES].sort();
    // moodAxes provides a vector for every axis.
    expect(Object.keys(m.moodAxes).sort()).toEqual(sortedAxes);
    for (const axis of MOOD_AXES) expect(m.moodAxes[axis].length).toBe(m.embeddingDim);
    // Every asset/text/audio mood is a complete, in-range vector — no undefined new axis.
    for (const a of [...m.assets, ...m.texts, ...m.audio]) {
      expect(Object.keys(a.mood).sort()).toEqual(sortedAxes);
      for (const axis of MOOD_AXES) {
        const v = a.mood[axis];
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every embedding is L2-normalized to ~1', () => {
    const m = parseManifest(seed);
    for (const a of [...m.assets, ...m.texts]) {
      const len = Math.sqrt(a.embedding.reduce((s, x) => s + x * x, 0));
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('rejects a manifest missing a required field', () => {
    const broken = structuredClone(seed) as Record<string, unknown>;
    delete broken.embeddingDim;
    expect(() => parseManifest(broken)).toThrow(ManifestError);
  });

  it('rejects an embedding whose length disagrees with embeddingDim', () => {
    const broken = structuredClone(seed) as typeof seed;
    broken.assets[0].embedding = [0.1, 0.2, 0.3];
    expect(() => parseManifest(broken)).toThrow(/embeddingDim/);
  });

  it('rejects a CC-BY asset with no attribution', () => {
    const broken = structuredClone(seed) as typeof seed;
    broken.assets[0].license = 'CC-BY-4.0';
    // ensure no attribution present
    delete (broken.assets[0] as Record<string, unknown>).attribution;
    expect(() => parseManifest(broken)).toThrow(/attribution/);
  });
});

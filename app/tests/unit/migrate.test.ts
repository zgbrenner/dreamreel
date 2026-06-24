import { describe, it, expect } from 'vitest';
import { migrateManifest } from '../../src/manifest/migrate';
import { parseManifest } from '../../src/manifest/loader';
import { MOOD_AXES } from '../../src/manifest/types';
import seed from '../../public/manifest.seed.json';

const ORIGINAL_SIX = ['melancholy', 'uncanny', 'nostalgic', 'ominous', 'tender', 'mechanical'];
const NEW_SIX = MOOD_AXES.filter((a) => !ORIGINAL_SIX.includes(a));

/** Strip the post-publish axes to simulate a legacy 6-axis production manifest. */
function makeLegacySixAxis(): Record<string, unknown> {
  const m = structuredClone(seed) as Record<string, unknown>;
  const drop = (mood: Record<string, unknown>) => {
    for (const a of NEW_SIX) delete mood[a];
  };
  drop(m.moodAxes as Record<string, unknown>);
  for (const key of ['assets', 'texts', 'audio'] as const) {
    for (const item of m[key] as Array<Record<string, unknown>>) {
      drop(item.mood as Record<string, unknown>);
    }
  }
  return m;
}

describe('migrateManifest — legacy manifest forward-compat', () => {
  it('a stripped 6-axis manifest would FAIL validation without migration', () => {
    // sanity: the raw legacy shape is genuinely rejected by the 12-axis schema
    const legacy = makeLegacySixAxis();
    const sixOnly = legacy.moodAxes as Record<string, unknown>;
    expect(Object.keys(sixOnly).sort()).toEqual([...ORIGINAL_SIX].sort());
  });

  it('backfills missing per-item mood axes with 0', () => {
    const migrated = migrateManifest(makeLegacySixAxis()) as typeof seed;
    for (const item of [...migrated.assets, ...migrated.texts, ...migrated.audio]) {
      for (const a of MOOD_AXES) expect(typeof item.mood[a]).toBe('number');
      for (const a of NEW_SIX) expect(item.mood[a as keyof typeof item.mood]).toBe(0);
    }
  });

  it('backfills missing top-level moodAxes with a zero vector of length embeddingDim', () => {
    const migrated = migrateManifest(makeLegacySixAxis()) as typeof seed;
    for (const a of NEW_SIX) {
      const vec = migrated.moodAxes[a as keyof typeof migrated.moodAxes];
      expect(vec.length).toBe(migrated.embeddingDim);
      expect(vec.every((x) => x === 0)).toBe(true);
    }
  });

  it('a legacy 6-axis manifest now PASSES parseManifest (no silent seed fallback)', () => {
    const m = parseManifest(makeLegacySixAxis());
    expect(m.assets.length).toBeGreaterThan(0);
    expect(Object.keys(m.moodAxes).sort()).toEqual([...MOOD_AXES].sort());
  });

  it('leaves a complete 12-axis manifest structurally unchanged (values preserved)', () => {
    const migrated = migrateManifest(seed) as typeof seed;
    expect(migrated.assets[0].mood).toEqual(seed.assets[0].mood);
    expect(migrated.moodAxes).toEqual(seed.moodAxes);
  });

  it('passes non-object input straight through for the schema to reject', () => {
    expect(migrateManifest(null)).toBe(null);
    expect(migrateManifest('nope')).toBe('nope');
  });
});

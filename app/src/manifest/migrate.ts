// app/src/manifest/migrate.ts
import { MOOD_AXES } from './types';

/**
 * Forward-migrate a manifest that was published before later mood axes existed, so an older
 * (e.g. 6-axis) PRODUCTION manifest still validates against the current 12-axis schema instead of
 * being rejected. Rejection is silent and costly: `loadManifest` throws, App falls back to the
 * bundled seed manifest, and the dream shows no real media — only procedural shaders.
 *
 * Missing axes default to 0 (mood absent) for per-item mood scalars, and to a zero vector of length
 * `embeddingDim` for the top-level `moodAxes` anchor arrays. A manifest that already carries every
 * axis passes through structurally unchanged. Pure: inputs are not mutated (shallow clones only),
 * and anything that doesn't look like a manifest is returned as-is for the schema to reject.
 */
export function migrateManifest(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const m = raw as Record<string, unknown>;
  const dim = typeof m.embeddingDim === 'number' ? m.embeddingDim : undefined;
  const out: Record<string, unknown> = { ...m };

  // Top-level moodAxes anchor vectors: backfill any missing axis with a zero vector (length dim).
  if (out.moodAxes && typeof out.moodAxes === 'object' && dim !== undefined) {
    const axes = { ...(out.moodAxes as Record<string, unknown>) };
    for (const a of MOOD_AXES) {
      if (!Array.isArray(axes[a])) axes[a] = new Array<number>(dim).fill(0);
    }
    out.moodAxes = axes;
  }

  // Per-item mood scalars on assets / texts / audio: backfill any missing axis with 0.
  for (const key of ['assets', 'texts', 'audio'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = item as Record<string, unknown>;
      if (!it.mood || typeof it.mood !== 'object') return item;
      const mood = { ...(it.mood as Record<string, unknown>) };
      let changed = false;
      for (const a of MOOD_AXES) {
        if (typeof mood[a] !== 'number') {
          mood[a] = 0;
          changed = true;
        }
      }
      return changed ? { ...it, mood } : item;
    });
  }

  return out;
}

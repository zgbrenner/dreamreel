// app/src/dream/visualPool.ts
import type { Asset } from '../manifest/types';

/**
 * Choose the assets the Dreamwalker is allowed to surface as PRIMARY visuals.
 *
 * Procedural sources are a graceful FALLBACK medium — shown only when a real asset fails to load
 * (conductor resolveLayerSlot/resolveVisual), to texture transitions, or as ghost echoes — never a
 * deliberate primary pick. So an archive-on dream walks real media + title cards, keeping it
 * media-first instead of drifting to an all-shaders look. The procedural pool is the safety net
 * only when there is genuinely no media to show (an all-procedural manifest) or archive is
 * explicitly off.
 *
 * Pure + standalone so the policy is unit-testable without standing up the WebGL conductor.
 */
export function visualPool(assets: Asset[], archiveOn: boolean): Asset[] {
  const media = assets.filter((a) => a.type !== 'procedural');
  if (archiveOn && media.length > 0) return media;
  return assets.filter((a) => a.type === 'procedural' || a.type === 'titlecard');
}

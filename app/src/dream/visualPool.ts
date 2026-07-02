// app/src/dream/visualPool.ts
import type { Asset } from '../manifest/types';

/**
 * Choose the assets the Dreamwalker is allowed to surface as PRIMARY (held) visuals.
 *
 * **Video-first** (2026 direction — see CLAUDE.md "Content & aesthetic direction"): dreams are
 * *moving*, and real dreams almost never contain still photographs. So when archive is on and the
 * corpus actually contains video, `video` (+ title cards) is the held-primary pool and `image`
 * assets are **demoted out of it** — stills live only in the rare flash-frame / ghost-layer path
 * (`flashFramePool`), never as a held primary beat. If a manifest has **no** video at all, images
 * are kept as primary so the reel still plays (graceful — a video-less corpus shouldn't go blank).
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
/** Fewer videos than this and the corpus can't sustain a video-only walk — a tiny pool recycles
 *  the same clips within the recent-window and title-card interjections dominate. */
export const MIN_PRIMARY_VIDEOS = 4;

export function visualPool(assets: Asset[], archiveOn: boolean): Asset[] {
  const media = assets.filter((a) => a.type !== 'procedural');
  if (archiveOn && media.length > 0) {
    // Video-first: hold `video` + title cards as primary and demote `image` to the flash/ghost
    // path — but only when there is enough real video to carry the dream. A video-less (or
    // video-starved) corpus keeps images primary so the reel still plays with variety.
    const videos = media.filter((a) => a.type === 'video');
    return videos.length >= MIN_PRIMARY_VIDEOS ? videos : media;
  }
  return assets.filter((a) => a.type === 'procedural' || a.type === 'titlecard');
}

/**
 * The DEMOTED `image` assets — the pool the rare flash-frame / ghost-layer texture path draws from.
 *
 * Non-empty **only** when `visualPool` actually demoted images (archive on AND the corpus has
 * video); otherwise the images are either already primary (a video-less corpus) or excluded
 * (archive off), so there is nothing to flash. Keeping this in lock-step with `visualPool` means a
 * still is never simultaneously a primary beat and a flash-frame.
 *
 * Pure + standalone so the policy is unit-testable without standing up the WebGL conductor.
 */
export function flashFramePool(assets: Asset[], archiveOn: boolean): Asset[] {
  if (!archiveOn) return [];
  const media = assets.filter((a) => a.type !== 'procedural');
  if (media.filter((a) => a.type === 'video').length < MIN_PRIMARY_VIDEOS) return [];
  return media.filter((a) => a.type === 'image');
}

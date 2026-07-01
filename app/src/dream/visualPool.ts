// app/src/dream/visualPool.ts
import type { Asset } from '../manifest/types';

/**
 * Minimum number of distinct `video` assets a corpus must have before the video-first policy
 * demotes stills out of the held-primary pool.
 *
 * Video-first only makes sense when there is ENOUGH video to actually carry the reel. A corpus with
 * one (or a couple of) clips can't hold every primary beat: the walk would sit on the same clip, and
 * — worse — if that clip is slow or fails to load, EVERY primary beat collapses to the procedural
 * fallback and the dream drifts to an all-static, floating-flash-frame look (the exact failure the
 * bundled seed manifest hit: a single dead-URL video demoted all 16 stills, so nothing real played).
 * Below this floor we keep stills in the primary pool so real media carries the dream; at/above it
 * the corpus is video-rich enough to go video-first as intended. The real R2 corpus (hundreds of
 * clips) is comfortably above the floor, so production is unaffected.
 */
export const MIN_VIDEO_FOR_VIDEO_FIRST = 3;

/**
 * Choose the assets the Dreamwalker is allowed to surface as PRIMARY (held) visuals.
 *
 * **Video-first** (2026 direction — see CLAUDE.md "Content & aesthetic direction"): dreams are
 * *moving*, and real dreams almost never contain still photographs. So when archive is on and the
 * corpus is genuinely video-rich (at least `MIN_VIDEO_FOR_VIDEO_FIRST` distinct clips), `video`
 * (+ title cards) is the held-primary pool and `image` assets are **demoted out of it** — stills
 * live only in the rare flash-frame / ghost-layer path (`flashFramePool`), never as a held primary
 * beat.
 *
 * If the corpus has **no** video — or only a THIN video pool (below the floor) that can't sustain a
 * video-first walk — images are kept as primary so the reel plays **real media** instead of
 * collapsing to procedural fallback. A video-poor corpus shouldn't go blank or drift to an
 * all-shaders look; the scarce clips still surface (the Dreamwalker up-weights `video`), they just
 * aren't the *only* held medium.
 *
 * Procedural sources are a graceful FALLBACK medium — shown only when a real asset fails to load
 * (conductor resolveLayerSlot/resolveVisual), to texture transitions, or as ghost echoes — never a
 * deliberate primary pick. The procedural pool is the safety net only when there is genuinely no
 * media to show (an all-procedural manifest) or archive is explicitly off.
 *
 * Pure + standalone so the policy is unit-testable without standing up the WebGL conductor.
 */
export function visualPool(assets: Asset[], archiveOn: boolean): Asset[] {
  const media = assets.filter((a) => a.type !== 'procedural');
  if (archiveOn && media.length > 0) {
    // Video-first — but only when the corpus can actually carry it. A thin video pool keeps images
    // primary so the reel shows real media rather than collapsing to procedural static.
    return videoFirst(media) ? media.filter((a) => a.type !== 'image') : media;
  }
  return assets.filter((a) => a.type === 'procedural' || a.type === 'titlecard');
}

/**
 * The DEMOTED `image` assets — the pool the rare flash-frame / ghost-layer texture path draws from.
 *
 * Non-empty **only** when `visualPool` actually demoted images (archive on AND a video-rich corpus);
 * otherwise the images are either already primary (a video-less or video-poor corpus) or excluded
 * (archive off), so there is nothing to flash. Keeping this in lock-step with `visualPool` means a
 * still is never simultaneously a primary beat and a flash-frame.
 *
 * Pure + standalone so the policy is unit-testable without standing up the WebGL conductor.
 */
export function flashFramePool(assets: Asset[], archiveOn: boolean): Asset[] {
  if (!archiveOn) return [];
  const media = assets.filter((a) => a.type !== 'procedural');
  if (!videoFirst(media)) return [];
  return media.filter((a) => a.type === 'image');
}

/** True when the media pool is video-rich enough to run the video-first (stills-demoted) policy. */
function videoFirst(media: Asset[]): boolean {
  return media.filter((a) => a.type === 'video').length >= MIN_VIDEO_FOR_VIDEO_FIRST;
}

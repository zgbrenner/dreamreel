// app/src/render/filmParams.ts
// Single home for every film-treatment parameter, so the audio/mood layer (prompt 6) and
// the conductor (prompt 8) drive the look from one place. These are the *base* levels; the
// PostFX dream-event engine layers slow LFOs and one-shot swells on top each frame, so the
// reel keeps breathing even when the mood holds steady.

export interface FilmParams {
  grain: number; // animated grain strength 0..1
  sepia: number; // global sepia toning 0..1
  desat: number; // desaturation 0..1
  vignette: number; // vignette darkness 0..1
  scanline: number; // scanline strength 0..1
  halation: number; // warm highlight bleed 0..1
  weaveAmp: number; // gate-weave amplitude (sub-pixel, in uv units)
  flicker: number; // brightness flicker depth 0..1
  spliceFlash: number; // transient white splice flash 0..1 (decays in JS)
  gradeSepia: number; // per-asset sepia override from Asset.grade, additive
  // --- dreamlike layer (base levels; the dream-event engine modulates around these) ---
  exposure: number; // base exposure multiplier (1 = neutral); dream blowouts swell above
  bloom: number; // soft over-exposed glow intensity (postprocessing BloomEffect)
  haze: number; // gauzy soft-focus veil that lifts shadows toward lamp-glow 0..1
  lightLeak: number; // drifting colored light-leak bleed 0..1
  tint: number; // slow color-temperature drift toward palette colors 0..1
  chroma: number; // chromatic aberration / color-fringing 0..1
  bleach: number; // transient over-exposure blowout 0..1 (decays in JS, like spliceFlash)
  breathe: number; // depth of the slow vignette/exposure "breathing" 0..1
  warp: number; // intensity-driven UV displacement 0..1 (dream fluidity)
  filmGrade: number; // master scale for the whole old-cinema treatment 0..1 (1 = full, 0 = off)
  reduceMotion: boolean;
}

export function defaultFilmParams(): FilmParams {
  return {
    grain: 0.22,
    sepia: 0.45,
    desat: 0.35,
    vignette: 0.55,
    scanline: 0.12,
    halation: 0.35,
    weaveAmp: 0.0016,
    flicker: 0.06,
    spliceFlash: 0,
    gradeSepia: 0,
    exposure: 1,
    bloom: 0.45,
    haze: 0.22,
    lightLeak: 0.3,
    tint: 0.25,
    chroma: 0.3,
    bleach: 0,
    breathe: 0.5,
    warp: 0,
    filmGrade: 1,
    reduceMotion: false,
  };
}

/** Parse an Asset.grade hint like "sepia 0.5" into an additive sepia amount. */
export function parseGrade(grade?: string): number {
  if (!grade) return 0;
  const m = /sepia\s+([0-9]*\.?[0-9]+)/i.exec(grade);
  return m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 0;
}

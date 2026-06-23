// app/src/dream/steering.ts
//
// Ambient behavioral steering. DREAMREEL has a single verb (New dream) and no sliders — but a
// dream can quietly *bend* to how a viewer behaves, then *relax* back. This module collects a
// handful of normalized, throttled signals from NATIVE browser APIs only (NO webcam, no mic):
//
//   • pointer attention  — where the cursor is, FADING to centre when it stops moving
//   • pointer speed       — how fast it's moving (presentation-only: shimmer/breathing)
//   • device tilt         — deviceorientation gamma/beta (presentation-only: parallax)
//   • idle                — how long since the viewer last did anything (0..1)
//   • focus               — is the document focused (1) or blurred (0)
//   • time of day         — 0..1 across 24h (presentation-only: warmth)
//
// Each is clamped to a small, documented range. The split between CONTENT signals (which the
// Dreamwalker turns into a bounded, self-relaxing bend of the seeded walk) and PRESENTATION
// signals (which only nudge the camera/film and never touch the dream script) is deliberate and
// load-bearing — see the field docs below and dreamwalker.ts / Compositor.ts.
//
// Determinism: the dream is reproducible given (seed + the recorded steering signal). With the
// NEUTRAL steering state (a passive viewer: still pointer, focused, not idle) the content bend is
// exactly zero, so the walk equals the pure seeded spine bit-for-bit. `neutralSteering()` is that
// zero point. The only SHAREABLE dream param is still `?seed=` — steering is live and ambient,
// never serialized.

/** A single normalized snapshot of ambient viewer behavior. All fields are pre-clamped. */
export interface SteeringState {
  /**
   * Pointer attention, normalized to [-1, 1] per axis (centre = 0). This is NOT the raw cursor
   * position: it decays toward 0 as the pointer goes still, so a passive viewer reads as 0.
   * CONTENT signal — leans the walk's next pick (see dreamwalker `setSteering`). Also feeds the
   * presentation parallax.
   */
  pointerX: number;
  pointerY: number;
  /** Pointer speed 0..1, decays when still. PRESENTATION-only (shimmer breathing). */
  pointerSpeed: number;
  /** Device tilt, [-1, 1] per axis from deviceorientation. PRESENTATION-only (parallax). */
  tiltX: number;
  tiltY: number;
  /** Idle ramp 0..1 — rises the longer the viewer is still. CONTENT signal — lengthens dwell. */
  idle: number;
  /** Document focus: 1 focused, 0 blurred. CONTENT signal — blur eases toward a coherence trough. */
  focus: number;
  /** Time of day 0..1 across 24h. PRESENTATION-only (film warmth). */
  timeOfDay: number;
  /** prefers-reduced-motion — when true, all motion-derived signals are damped at the source. */
  reduceMotion: boolean;
}

/**
 * The zero / passive-viewer steering state: still pointer, focused, not idle, neutral time. The
 * Dreamwalker treats this exactly like "no steering": content bend is zero and the walk reproduces
 * the seeded spine bit-for-bit. timeOfDay defaults to midday (0.5); focus defaults to 1.
 */
export function neutralSteering(): SteeringState {
  return {
    pointerX: 0,
    pointerY: 0,
    pointerSpeed: 0,
    tiltX: 0,
    tiltY: 0,
    idle: 0,
    focus: 1,
    timeOfDay: 0.5,
    reduceMotion: false,
  };
}

// --- presentation shimmer (pure mapping; APPLIED in Compositor.ts) -----------------------------

/** A bounded camera nudge: pan in normalized device units + a gentle zoom. Presentation-only. */
export interface ShimmerOffset {
  dx: number;
  dy: number;
  zoom: number;
}

/** Max parallax pan (NDC units) and max extra zoom — both deliberately tiny so framing only breathes. */
export const SHIMMER_PAN = 0.03;
export const SHIMMER_BREATHE = 0.02;

/**
 * Map steering to a bounded camera shimmer. PURE — it reads steering and returns an offset; it
 * never touches the Dreamwalker, so it cannot change which assets/text/events occur. Pointer and
 * device tilt drive parallax; pointer speed drives a faint breathing zoom. Reduced-motion damps it.
 */
export function shimmerFromSteering(s: SteeringState): ShimmerOffset {
  const damp = s.reduceMotion ? 0.12 : 1;
  const dx = clamp((s.pointerX * 0.6 + s.tiltX * 0.4) * SHIMMER_PAN * damp, -SHIMMER_PAN, SHIMMER_PAN);
  const dy = clamp((s.pointerY * 0.6 + s.tiltY * 0.4) * SHIMMER_PAN * damp, -SHIMMER_PAN, SHIMMER_PAN);
  const zoom = 1 + clamp(s.pointerSpeed * SHIMMER_BREATHE * damp, 0, SHIMMER_BREATHE);
  return { dx, dy, zoom };
}

// --- live controller (DOM; guarded so it imports cleanly under node/test) ----------------------

/** Live source of SteeringState. Read `.state` each frame; call `dispose()` to detach listeners. */
export interface SteeringController {
  readonly state: SteeringState;
  dispose(): void;
}

// Time constants (ms). Attention and pointer-speed fade with their own taus; idle saturates over
// IDLE_FULL_MS. These are gentle on purpose — the bend is meant to be felt, not seen.
const POINTER_TAU_MS = 1200;
const SPEED_TAU_MS = 450;
const IDLE_FULL_MS = 8000;
const REDUCED_DAMP = 0.12;

/**
 * Construct a live controller from native events. Outside a browser (e.g. unit tests) it returns a
 * static neutral controller, so importing this module never requires a DOM. State is derived LAZILY
 * from timestamps on read — no polling timer — so attention/idle/speed decay smoothly with no extra
 * RAF loop of their own.
 */
export function createSteeringController(opts?: { reduceMotion?: boolean }): SteeringController {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    const state = neutralSteering();
    if (opts?.reduceMotion) state.reduceMotion = true;
    return { state, dispose() {} };
  }

  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const reduceMq =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const reduceMotion = (): boolean => opts?.reduceMotion ?? reduceMq?.matches ?? false;

  // Mutable raw inputs; the public `state` getter turns these into the normalized snapshot.
  let rawX = 0;
  let rawY = 0;
  let lastMoveAt = now() - IDLE_FULL_MS; // start "idle" so a hands-off open reads as passive
  let lastSpeed = 0;
  let lastSampleAt = now();
  let tiltX = 0;
  let tiltY = 0;
  let focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

  const onPointerMove = (e: PointerEvent | MouseEvent): void => {
    const t = now();
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const nx = (e.clientX / w) * 2 - 1;
    const ny = -((e.clientY / h) * 2 - 1);
    // Throttle the speed estimate to ~one sample per frame; position always tracks.
    const dt = t - lastSampleAt;
    if (dt >= 12) {
      const dist = Math.hypot(nx - rawX, ny - rawY);
      // normalize: crossing ~half the viewport in 100ms ≈ full speed
      lastSpeed = clamp((dist / Math.max(dt, 1)) * 100, 0, 1);
      lastSampleAt = t;
    }
    rawX = clamp(nx, -1, 1);
    rawY = clamp(ny, -1, 1);
    lastMoveAt = t;
  };

  const onOrient = (e: DeviceOrientationEvent): void => {
    if (e.gamma != null) tiltX = clamp(e.gamma / 45, -1, 1); // left/right
    if (e.beta != null) tiltY = clamp((e.beta - 45) / 45, -1, 1); // front/back, neutral ~45°
    lastMoveAt = now();
  };

  const onFocus = (): void => {
    focused = true;
    lastMoveAt = now();
  };
  const onBlur = (): void => {
    focused = false;
  };
  const onVisibility = (): void => {
    focused = document.visibilityState === 'visible';
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('deviceorientation', onOrient, { passive: true });
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  const controller: SteeringController = {
    get state(): SteeringState {
      const t = now();
      const sinceMove = t - lastMoveAt;
      const rm = reduceMotion();
      const motionDamp = rm ? REDUCED_DAMP : 1;

      // Attention fades to centre when the pointer stops; speed fades faster.
      const attn = Math.exp(-sinceMove / POINTER_TAU_MS);
      const speedFade = Math.exp(-sinceMove / SPEED_TAU_MS);
      const idle = clamp(sinceMove / IDLE_FULL_MS, 0, 1);

      // time of day 0..1
      const d = new Date();
      const timeOfDay = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;

      return {
        // Attention itself is position, not motion — keep it for a steady lean, but soften under RM.
        pointerX: rawX * attn * (rm ? 0.5 : 1),
        pointerY: rawY * attn * (rm ? 0.5 : 1),
        pointerSpeed: lastSpeed * speedFade * motionDamp,
        tiltX: tiltX * motionDamp,
        tiltY: tiltY * motionDamp,
        idle,
        focus: focused ? 1 : 0,
        timeOfDay,
        reduceMotion: rm,
      };
    },
    dispose(): void {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('deviceorientation', onOrient);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
  return controller;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

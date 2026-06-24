// app/src/render/postfx.ts
// The unified old-cinema-meets-dream treatment. A single merged film Effect (one fragment
// shader) does grade-aware sepia/desaturation, animated grain, scanlines, a breathing
// vignette, warm halation, gate-weave (uv jitter), exposure/over-exposure, a gauzy soft-focus
// haze veil, drifting colored light leaks, a slow color-temperature tint drift, brightness
// flicker and splice flash. A postprocessing BloomEffect is merged into the same EffectPass
// for dreamy over-exposed glow; a final ChromaticAberrationEffect pass adds color fringing.
//
// On top of the static base levels (filmParams.ts), a deterministic dream-event engine runs
// slow LFOs and randomized one-shot swells (over-exposure blowouts, bloom flares, light-leak
// sweeps, color washes, chroma surges, iris breaths) so the reel never sits still — it keeps
// drifting the way a dream does. The film look is not part of the deterministic dream script,
// so this stochastic layer is free to vary frame timing and intensity.
//
// Pass count: RenderPass + EffectPass(film + bloom) + EffectPass(chroma) = 3 passes total.
// Dust and scratches are textured quads (dust.ts) inside the first render pass — not per-pixel.
// Reference for the filmic approach: Matt DesLauriers, "Filmic Effects in WebGL".

import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  Effect,
  BloomEffect,
  ChromaticAberrationEffect,
  BlendFunction,
} from 'postprocessing';
import type { Compositor } from './Compositor';
import { DustField } from './dust';
import { defaultFilmParams, type FilmParams } from './filmParams';
import { makeRng, type Rng } from '../dream/prng';
import { DreamFilter } from './DreamFilter';
import type { FilterStrengths } from '../dream/filterDirector';
import { SNOISE3D_GLSL } from './shaderNoise';

const FILM_FRAG = /* glsl */ `
${SNOISE3D_GLSL}
uniform float uTime;
uniform float uGrain;
uniform float uSepia;
uniform float uDesat;
uniform float uVignette;
uniform float uScanline;
uniform float uHalation;
uniform vec2  uWeave;
uniform float uBright;     // flicker * splice composited in JS into one brightness mul
uniform float uExposure;   // exposure multiplier (over-exposure blowouts push this up)
uniform float uHaze;       // gauzy soft-focus veil strength
uniform float uLeak;       // light-leak strength
uniform vec2  uLeakPos;    // light-leak centre, drifting in uv space
uniform vec3  uLeakColor;  // light-leak colour
uniform float uTint;       // colour-temperature drift amount
uniform vec3  uTintColor;  // multiplicative tint target (near white)
uniform float uVigFringe;  // cool colour fringe near the vignette edge
uniform float uWarp;       // intensity-driven UV displacement 0..1 (dream fluidity)
uniform float uFilmGrade;  // master scale for the old-cinema treatment (1 = full, 0 = bypass)

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const vec3 HAZE_COLOR = vec3(0.91, 0.78, 0.53); // lamp glow #E8C887

// Warp the sampling UV for gate-weave (sub-pixel jitter) before the input is read.
// On top of the weave, an intensity-driven flowing displacement gives the frame a liquid,
// dreamlike drift. At uWarp = 0 the offset is exactly zero (identical to today's weave-only).
void mainUv(inout vec2 uv) {
  uv += uWeave;
  vec2 w = vec2(
    sin(uv.y * 9.0 + uTime * 0.7),
    cos(uv.x * 11.0 + uTime * 0.5)
  );
  uv += w * uWarp * 0.004;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  float aspect = resolution.x / resolution.y;

  // exposure / over-exposure (dream blowouts swell this above 1)
  col *= uExposure;

  // desaturate toward luminance
  float lum = dot(col, LUMA);
  col = mix(col, vec3(lum), uDesat);

  // sepia tone
  vec3 sepiaCol = vec3(
    dot(col, vec3(0.393, 0.769, 0.189)),
    dot(col, vec3(0.349, 0.686, 0.168)),
    dot(col, vec3(0.272, 0.534, 0.131))
  );
  col = mix(col, sepiaCol, uSepia);

  // slow colour-temperature drift toward a palette tint (subtle, multiplicative)
  col = mix(col, col * uTintColor, uTint);

  // gauzy soft-focus haze: lift the shadows toward lamp-glow so the frame reads dreamlike
  col += HAZE_COLOR * uHaze * (1.0 - lum) * 0.6;

  // warm halation: highlights bleed amber (non-spatial, cheap)
  float hi = smoothstep(0.6, 1.0, lum);
  col += vec3(0.30, 0.20, 0.08) * hi * uHalation;

  // drifting coloured light leak (additive radial bleed, aspect-corrected)
  vec2 ld = uv - uLeakPos;
  ld.x *= aspect;
  float leak = smoothstep(0.75, 0.0, length(ld));
  col += uLeakColor * leak * uLeak;

  // organic film grain: two-octave simplex (Ashima webgl-noise) at a fine, time-animated scale,
  // weighted toward the midtones the way real emulsion grain reads. Deterministic in uTime; the
  // 0.5 factor matches the amplitude of the previous white-noise grain so existing uGrain tuning
  // is preserved, and uGrain == 0 still leaves the frame untouched.
  float grain = sn_fbm2(vec3(uv * resolution.xy * 0.5, uTime * 24.0));
  float grainLum = mix(0.65, 1.0, 1.0 - abs(lum - 0.5) * 2.0);
  col += grain * uGrain * grainLum * 0.5;

  // scanlines
  float sl = sin(uv.y * resolution.y * 3.14159);
  col *= 1.0 - uScanline * 0.5 * (0.5 + 0.5 * sl);

  // vignette (uVignette is animated in JS for a slow breath)
  vec2 d = uv - 0.5;
  float vig = smoothstep(0.85, 0.35, length(d) * 1.41421);
  // cool colour fringe creeping in from the darkened edges
  col = mix(col, col * vec3(0.82, 0.95, 1.08), (1.0 - vig) * uVigFringe);
  col *= mix(1.0, vig, uVignette);

  // global brightness (flicker + splice flash)
  col *= uBright;

  // master film-grade scale: lerp between the untreated sampled colour and the fully-graded
  // colour. At uFilmGrade = 1 this is exactly the graded col (identical to today); at 0 the
  // whole old-cinema treatment is bypassed and the raw image passes through.
  col = mix(inputColor.rgb, col, uFilmGrade);

  outputColor = vec4(clamp(col, 0.0, 1.0), inputColor.a);
}
`;

class FilmEffect extends Effect {
  constructor() {
    super('FilmEffect', FILM_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uTime', new THREE.Uniform(0)],
        ['uGrain', new THREE.Uniform(0.22)],
        ['uSepia', new THREE.Uniform(0.45)],
        ['uDesat', new THREE.Uniform(0.35)],
        ['uVignette', new THREE.Uniform(0.55)],
        ['uScanline', new THREE.Uniform(0.12)],
        ['uHalation', new THREE.Uniform(0.35)],
        ['uWeave', new THREE.Uniform(new THREE.Vector2(0, 0))],
        ['uBright', new THREE.Uniform(1)],
        ['uExposure', new THREE.Uniform(1)],
        ['uHaze', new THREE.Uniform(0.22)],
        ['uLeak', new THREE.Uniform(0)],
        ['uLeakPos', new THREE.Uniform(new THREE.Vector2(0.8, 0.2))],
        ['uLeakColor', new THREE.Uniform(new THREE.Color(0.91, 0.78, 0.53))],
        ['uTint', new THREE.Uniform(0.25)],
        ['uTintColor', new THREE.Uniform(new THREE.Color(1, 0.98, 0.9))],
        ['uVigFringe', new THREE.Uniform(0.25)],
        ['uWarp', new THREE.Uniform(0)],
        ['uFilmGrade', new THREE.Uniform(1)],
      ]),
    });
  }
  setTime(t: number): void {
    (this.uniforms.get('uTime') as THREE.Uniform).value = t;
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name) as THREE.Uniform;
  }
}

// Palette colours (linear-ish 0..1) the dream engine drifts the look through.
const PAL = {
  amber: new THREE.Color(0.784, 0.639, 0.369), // #C8A35E
  lamp: new THREE.Color(0.91, 0.78, 0.53), // #E8C887
  verdigris: new THREE.Color(0.29, 0.42, 0.4), // #4A6B66
  bone: new THREE.Color(0.847, 0.824, 0.769), // #D8D2C4
};
// Warm / cool tint targets (kept near white so the drift stays subtle).
const TINT_WARM = new THREE.Color(1.08, 0.98, 0.82);
const TINT_COOL = new THREE.Color(0.86, 1.0, 1.04);

type EventTarget = 'bleach' | 'bloom' | 'vignette' | 'leak' | 'tint' | 'chroma';

interface DreamEvent {
  target: EventTarget;
  t: number; // elapsed within the event
  dur: number; // total duration
  amp: number; // peak amplitude
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly params: FilmParams = defaultFilmParams();
  private readonly effect = new FilmEffect();
  private readonly dreamFilter = new DreamFilter();
  private readonly bloom = new BloomEffect({
    intensity: 0.45,
    luminanceThreshold: 0.62,
    luminanceSmoothing: 0.4,
    mipmapBlur: true,
    radius: 0.7,
  });
  private readonly chroma = new ChromaticAberrationEffect({
    blendFunction: BlendFunction.NORMAL,
    offset: new THREE.Vector2(0, 0),
    radialModulation: true,
    modulationOffset: 0.35,
  });
  private readonly dust = new DustField();
  private weavePhase = 0;
  private flickerPhase = 0;

  // dream-event engine
  private readonly rng: Rng = makeRng('dreamfx');
  private readonly events: DreamEvent[] = [];
  private nextEventAt = 1.5;
  private readonly leakColor = new THREE.Color().copy(PAL.lamp);
  private readonly tintColor = new THREE.Color(1, 0.98, 0.9);

  constructor(compositor: Compositor) {
    compositor.addOverlay(this.dust.group);

    this.composer = new EffectComposer(compositor.renderer);
    this.composer.addPass(new RenderPass(compositor.scene, compositor.camera));
    // Film grade + bloom merge into one pass; chromatic aberration is a convolution effect
    // (it reads neighbouring texels) and conflicts with the film effect's mainUv weave, so
    // it gets its own pass.
    this.composer.addPass(new EffectPass(compositor.camera, this.dreamFilter, this.effect, this.bloom));
    this.composer.addPass(new EffectPass(compositor.camera, this.chroma));

    const { width, height } = compositor.size;
    this.composer.setSize(width, height);
    compositor.onResize = (w, h) => this.composer.setSize(w, h);

    // Route the compositor's single rAF render through the composer.
    compositor.renderFrame = () => this.composer.render();
    // Drive per-frame film animation from the compositor's frame listeners.
    compositor.addFrameListener((dt, elapsed) => this.update(dt, elapsed));
    this.applyParams();
  }

  /** Number of render passes in the chain (acceptance asks us to report this). */
  get passCount(): number {
    return this.composer.passes.length;
  }

  setParams(patch: Partial<FilmParams>): void {
    Object.assign(this.params, patch);
    this.applyParams();
  }

  /** Drive the dream-filter catalog (the 5 fragment filters). feedback is handled by LayerStack. */
  setFilterStrengths(s: FilterStrengths): void {
    this.dreamFilter.setStrengths(s);
  }

  /** Per-asset grade hint -> additive sepia for the current beat. */
  setGradeSepia(amount: number): void {
    this.params.gradeSepia = amount;
    this.effect.u('uSepia').value = Math.min(1, this.params.sepia + amount);
  }

  /** Fire a transient white splice flash (decays in update). */
  triggerSplice(strength = 1): void {
    this.params.spliceFlash = Math.max(this.params.spliceFlash, strength);
    // A splice is a fine moment to bleed a little over-exposure into the frame.
    this.params.bleach = Math.max(this.params.bleach, strength * 0.5);
  }

  /** Kick a one-shot dream swell on a chosen channel (used on beats / non-sequiturs). */
  triggerDreamSurge(target: EventTarget = 'bloom', strength = 1): void {
    this.spawnEvent(target, strength);
  }

  setIntensity(reduceMotion: boolean): void {
    this.params.reduceMotion = reduceMotion;
    this.dust.setIntensity(reduceMotion);
    this.applyParams();
  }

  private applyParams(): void {
    const p = this.params;
    this.effect.u('uGrain').value = p.grain;
    this.effect.u('uSepia').value = Math.min(1, p.sepia + p.gradeSepia);
    this.effect.u('uDesat').value = p.desat;
    this.effect.u('uVignette').value = p.vignette;
    this.effect.u('uScanline').value = p.scanline;
    this.effect.u('uHalation').value = p.halation;
    // dynamic uniforms (vignette/exposure/bloom/leak/tint/chroma) are written in update();
    // seed them here so a paused first frame still looks composed.
    this.effect.u('uHaze').value = p.haze;
    this.effect.u('uWarp').value = p.warp;
    this.effect.u('uFilmGrade').value = p.filmGrade;
    this.bloom.intensity = p.bloom;
  }

  private spawnEvent(target: EventTarget, strength: number): void {
    // attack+release humps; vignette/tint breathe slower, blowouts/chroma snap quicker.
    const slow = target === 'tint' || target === 'vignette' || target === 'leak';
    const dur = (slow ? 5 : 2.2) * (0.7 + this.rng.next() * 0.8);
    this.events.push({ target, t: 0, dur, amp: strength });
  }

  /** Sum the active one-shot envelopes for a given channel (sine hump, 0 at the ends). */
  private envelope(target: EventTarget): number {
    let sum = 0;
    for (const e of this.events) {
      if (e.target !== target) continue;
      sum += e.amp * Math.sin(Math.PI * Math.min(1, e.t / e.dur));
    }
    return sum;
  }

  private update(dt: number, elapsed: number): void {
    const p = this.params;
    const motion = p.reduceMotion ? 0.25 : 1;

    this.effect.setTime(elapsed);
    this.dreamFilter.setTime(elapsed);

    // --- advance the dream-event engine ---
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      e.t += dt;
      if (e.t >= e.dur) this.events.splice(i, 1);
    }
    if (elapsed >= this.nextEventAt) {
      // pick a channel at random; calmer reels (reduced motion) fire less often / weaker.
      const targets: EventTarget[] = ['bleach', 'bloom', 'vignette', 'leak', 'tint', 'chroma'];
      const target = targets[this.rng.int(targets.length)];
      this.spawnEvent(target, (0.4 + this.rng.next() * 0.6) * motion);
      // next surge in 4..11s (further apart when motion is dampened)
      this.nextEventAt = elapsed + (4 + this.rng.next() * 7) / Math.max(0.4, motion);
    }

    // slow "breathing" LFO shared by vignette + exposure (gives the reel a pulse)
    const breath = Math.sin(elapsed * 0.18 * motion) * 0.5 + 0.5;
    const breatheDepth = p.breathe * motion;

    // gate-weave: small wandering sub-pixel offset
    this.weavePhase += dt * 7 * motion;
    const wa = p.weaveAmp * motion;
    (this.effect.u('uWeave').value as THREE.Vector2).set(
      Math.sin(this.weavePhase) * wa,
      Math.cos(this.weavePhase * 1.37) * wa * 0.6,
    );

    // brightness flicker + decaying splice flash -> one brightness multiplier
    this.flickerPhase += dt * 12 * motion;
    const flick = 1 - p.flicker * motion * (0.5 + 0.5 * Math.sin(this.flickerPhase)) * 0.5;
    p.spliceFlash = Math.max(0, p.spliceFlash - dt * 4);
    p.bleach = Math.max(0, p.bleach - dt * 1.2);
    this.effect.u('uBright').value = flick + p.spliceFlash * 0.6;

    // exposure: base + breath + decaying bleach + blowout events
    const expo = p.exposure + breath * breatheDepth * 0.12 + p.bleach * 0.5 + this.envelope('bleach') * 0.45;
    this.effect.u('uExposure').value = expo;

    // vignette: base + (inverted) breath + iris-breath events, clamped
    const vig = p.vignette + (0.5 - breath) * breatheDepth * 0.18 + this.envelope('vignette') * 0.35;
    this.effect.u('uVignette').value = THREE.MathUtils.clamp(vig, 0, 1);

    // haze breathes a touch so the soft-focus veil swells and recedes
    this.effect.u('uHaze').value = THREE.MathUtils.clamp(p.haze + breath * breatheDepth * 0.1, 0, 1);

    // light leak: drifting position + base level + slow swell + sweep events
    const lp = this.effect.u('uLeakPos').value as THREE.Vector2;
    lp.set(
      0.5 + Math.sin(elapsed * 0.07 * motion) * 0.55 + Math.sin(elapsed * 0.13) * 0.12,
      0.5 + Math.cos(elapsed * 0.05 * motion + 1.3) * 0.55,
    );
    const leakLfo = (Math.sin(elapsed * 0.11 * motion + 2.0) * 0.5 + 0.5) * 0.6;
    const leakAmt = THREE.MathUtils.clamp(p.lightLeak * (0.4 + leakLfo) + this.envelope('leak') * 0.8, 0, 1.4);
    this.effect.u('uLeak').value = leakAmt;
    // shift the leak colour slowly between lamp glow and amber, with verdigris on big sweeps.
    const leakMix = Math.sin(elapsed * 0.09) * 0.5 + 0.5;
    this.leakColor.copy(PAL.lamp).lerp(PAL.amber, leakMix);
    if (this.envelope('leak') > 0.5) this.leakColor.lerp(PAL.verdigris, 0.35);
    (this.effect.u('uLeakColor').value as THREE.Color).copy(this.leakColor);

    // colour-temperature drift: lerp warm<->cool slowly; events deepen the wash.
    const tintPhase = Math.sin(elapsed * 0.06 * motion) * 0.5 + 0.5;
    this.tintColor.copy(TINT_WARM).lerp(TINT_COOL, tintPhase);
    (this.effect.u('uTintColor').value as THREE.Color).copy(this.tintColor);
    this.effect.u('uTint').value = THREE.MathUtils.clamp(p.tint + this.envelope('tint') * 0.5, 0, 0.9);

    // bloom: base + breath + flare events
    this.bloom.intensity = Math.max(0, p.bloom + breath * 0.15 + this.envelope('bloom') * 0.9);

    // chromatic aberration: tiny base + surge events, gentle idle wobble
    const chromaAmt = p.chroma * 0.0018 + this.envelope('chroma') * 0.004;
    const wob = Math.sin(elapsed * 0.4) * 0.0004 * motion;
    (this.chroma.offset as THREE.Vector2).set(chromaAmt + wob, chromaAmt * 0.6);

    this.dust.update(dt, elapsed);
  }

  dispose(): void {
    this.dust.dispose();
    this.composer.dispose(); // disposes each pass and its effects (bloom/chroma/film)
  }
}

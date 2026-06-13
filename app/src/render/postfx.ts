// app/src/render/postfx.ts
// The unified old-cinema treatment: one merged film Effect (a single fragment shader, one
// EffectPass) doing grade-aware sepia/desaturation, animated grain, scanlines, vignette,
// warm halation, gate-weave (uv jitter), brightness flicker and splice flash. Dust and
// scratches are textured quads (dust.ts) inside the same render pass — not per-pixel.
//
// Pass count: RenderPass + EffectPass = 2 passes total (reported by passCount).
// Reference for the filmic approach: Matt DesLauriers, "Filmic Effects in WebGL".

import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, Effect } from 'postprocessing';
import type { Compositor } from './Compositor';
import { DustField } from './dust';
import { defaultFilmParams, type FilmParams } from './filmParams';

const FILM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGrain;
uniform float uSepia;
uniform float uDesat;
uniform float uVignette;
uniform float uScanline;
uniform float uHalation;
uniform vec2  uWeave;
uniform float uBright;   // flicker * splice composited in JS into one brightness mul

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// Warp the sampling UV for gate-weave (sub-pixel jitter) before the input is read.
void mainUv(inout vec2 uv) {
  uv += uWeave;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;

  // desaturate toward luminance
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), uDesat);

  // sepia tone
  vec3 sepiaCol = vec3(
    dot(col, vec3(0.393, 0.769, 0.189)),
    dot(col, vec3(0.349, 0.686, 0.168)),
    dot(col, vec3(0.272, 0.534, 0.131))
  );
  col = mix(col, sepiaCol, uSepia);

  // warm halation: highlights bleed amber (non-spatial, cheap)
  float hi = smoothstep(0.6, 1.0, lum);
  col += vec3(0.30, 0.20, 0.08) * hi * uHalation;

  // animated film grain
  float g = hash21(uv * resolution.xy + uTime * 60.0);
  col += (g - 0.5) * uGrain;

  // scanlines
  float sl = sin(uv.y * resolution.y * 3.14159);
  col *= 1.0 - uScanline * 0.5 * (0.5 + 0.5 * sl);

  // vignette
  vec2 d = uv - 0.5;
  float vig = smoothstep(0.85, 0.35, length(d) * 1.41421);
  col *= mix(1.0, vig, uVignette);

  // global brightness (flicker + splice flash)
  col *= uBright;

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

export class PostFX {
  readonly composer: EffectComposer;
  readonly params: FilmParams = defaultFilmParams();
  private readonly effect = new FilmEffect();
  private readonly dust = new DustField();
  private weavePhase = 0;
  private flickerPhase = 0;

  constructor(compositor: Compositor) {
    compositor.addOverlay(this.dust.group);

    this.composer = new EffectComposer(compositor.renderer);
    this.composer.addPass(new RenderPass(compositor.scene, compositor.camera));
    this.composer.addPass(new EffectPass(compositor.camera, this.effect));

    const { width, height } = compositor.size;
    this.composer.setSize(width, height);
    compositor.onResize = (w, h) => this.composer.setSize(w, h);

    // Route the compositor's single rAF render through the composer.
    compositor.renderFrame = () => this.composer.render();
    // Drive per-frame film animation from the compositor's frame hook chain.
    const prev = compositor.onFrame;
    compositor.onFrame = (dt, elapsed) => {
      prev?.(dt, elapsed);
      this.update(dt, elapsed);
    };
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

  /** Per-asset grade hint -> additive sepia for the current beat. */
  setGradeSepia(amount: number): void {
    this.params.gradeSepia = amount;
    this.effect.u('uSepia').value = Math.min(1, this.params.sepia + amount);
  }

  /** Fire a transient white splice flash (decays in update). */
  triggerSplice(strength = 1): void {
    this.params.spliceFlash = Math.max(this.params.spliceFlash, strength);
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
  }

  private update(dt: number, elapsed: number): void {
    const p = this.params;
    const motion = p.reduceMotion ? 0.25 : 1;

    this.effect.setTime(elapsed);

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
    this.effect.u('uBright').value = flick + p.spliceFlash * 0.6;

    this.dust.update(dt, elapsed);
  }

  dispose(): void {
    this.dust.dispose();
    this.composer.dispose();
  }
}

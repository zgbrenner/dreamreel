// app/src/render/DreamLayerMaterial.ts
//
// Two MeshBasicMaterial subclasses that inject a few lines into three.js's built-in shader via
// onBeforeCompile — keeping ALL basic-material behavior (map/opacity/blending/transparent, video
// texture decode, color-space handling) while adding dream-specific UV work:
//
//   DepthLayerMaterial  — 2.5D depth-parallax: when a baked depth map (pipeline/embed/depth.py,
//                         Asset.depthSrc) is bound, sampling UVs shift by (depth-0.5)*uParallax,
//                         so near pixels drift against far ones. No depth bound → the injected
//                         branch is skipped and sampling is exactly stock (flat, bit-identical).
//
//   MoshFeedbackMaterial — datamosh-style smear for the LayerStack feedback buffer: the previous
//                         composite is re-sampled displaced along a flow field (a baked RG flow
//                         texture from pipeline/embed/flow.py when available, else a seeded
//                         procedural swirl), compounding through the feedback ping-pong into the
//                         "image dissolving along its own motion" nightmare-surge look
//                         (KinoDatamosh-inspired; that reference implementation is Unlicense).
//                         uMosh = 0 → zero displacement → stock sampling.
//
// The injection replaces `#include <map_fragment>` with a prelude computing a displaced local UV
// and a `#define vMapUv <local>` so the untouched stock chunk (including DECODE_VIDEO_TEXTURE and
// color-space code, which vary across three versions) reads the displaced coordinate. This keeps
// the patch version-resilient — we never copy chunk internals.

import * as THREE from 'three';

function injectUvPrelude(shader: { fragmentShader: string }, uniformDecls: string, prelude: string): void {
  // `vMapUv` is only declared by three.js under USE_MAP — a material with no texture bound (e.g.
  // the feedback quad at the coherent baseline) compiles WITHOUT it, so the whole displaced-UV
  // prelude must be guarded on USE_MAP. The stock `#include <map_fragment>` stays unconditional
  // (it no-ops when USE_MAP is undefined); only our additions are gated.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    [
      '#ifdef USE_MAP',
      'vec2 dreamMapUv = vMapUv;',
      prelude,
      '#define vMapUv dreamMapUv',
      '#endif',
      '#include <map_fragment>',
      '#ifdef USE_MAP',
      '#undef vMapUv',
      '#endif',
    ].join('\n'),
  );
  shader.fragmentShader = uniformDecls + '\n' + shader.fragmentShader;
}

export class DepthLayerMaterial extends THREE.MeshBasicMaterial {
  private readonly uDepthMap = { value: null as THREE.Texture | null };
  private readonly uParallax = { value: new THREE.Vector2(0, 0) };
  private readonly uHasDepth = { value: 0 };

  constructor(params?: THREE.MeshBasicMaterialParameters) {
    super(params);
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uDepthMap = this.uDepthMap;
      shader.uniforms.uParallax = this.uParallax;
      shader.uniforms.uHasDepth = this.uHasDepth;
      injectUvPrelude(
        shader,
        'uniform sampler2D uDepthMap;\nuniform vec2 uParallax;\nuniform float uHasDepth;',
        `#ifdef USE_MAP
        if (uHasDepth > 0.5) {
          float dreamDepth = texture2D(uDepthMap, vMapUv).r - 0.5;
          dreamMapUv = clamp(vMapUv + dreamDepth * uParallax, 0.0, 1.0);
        }
        #endif`,
      );
    };
    // All instances share one injected program (uniforms differ per material instance).
    this.customProgramCacheKey = () => 'dream-depth-layer';
  }

  /** Bind (or clear) the baked depth map. Not disposed here — the caller owns its lifecycle. */
  setDepth(tex: THREE.Texture | null): void {
    this.uDepthMap.value = tex;
    this.uHasDepth.value = tex ? 1 : 0;
  }

  get depthTexture(): THREE.Texture | null {
    return this.uDepthMap.value;
  }

  /** Parallax offset in UV units (small — ±0.03 reads as gentle dimensional drift). */
  setParallax(x: number, y: number): void {
    this.uParallax.value.set(x, y);
  }
}

export class MoshFeedbackMaterial extends THREE.MeshBasicMaterial {
  private readonly uMosh = { value: 0 };
  private readonly uMoshTime = { value: 0 };
  private readonly uFlowMap = { value: null as THREE.Texture | null };
  private readonly uHasFlow = { value: 0 };

  constructor(params?: THREE.MeshBasicMaterialParameters) {
    super(params);
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uMosh = this.uMosh;
      shader.uniforms.uMoshTime = this.uMoshTime;
      shader.uniforms.uFlowMap = this.uFlowMap;
      shader.uniforms.uHasFlow = this.uHasFlow;
      injectUvPrelude(
        shader,
        'uniform float uMosh;\nuniform float uMoshTime;\nuniform sampler2D uFlowMap;\nuniform float uHasFlow;',
        `#ifdef USE_MAP
        if (uMosh > 0.001) {
          vec2 dreamFlow;
          if (uHasFlow > 0.5) {
            // Baked RG flow (pipeline/embed/flow.py encoding): 0.5 = zero displacement.
            dreamFlow = (texture2D(uFlowMap, vMapUv).rg - 0.5) * 2.0;
          } else {
            // Procedural swirl fallback — a coherent, slowly-turning field.
            float a = vMapUv.y * 7.3 + uMoshTime * 0.7;
            float b = vMapUv.x * 6.1 - uMoshTime * 0.9;
            dreamFlow = vec2(sin(a) + 0.4 * sin(b * 1.7), cos(b) + 0.4 * cos(a * 1.3)) * 0.5;
          }
          dreamMapUv = clamp(vMapUv + dreamFlow * uMosh * 0.05, 0.0, 1.0);
        }
        #endif`,
      );
    };
    this.customProgramCacheKey = () => 'dream-mosh-feedback';
  }

  /** Smear strength 0..1 (0 = stock sampling, bit-identical feedback trail). */
  setMosh(strength: number): void {
    this.uMosh.value = Math.max(0, Math.min(1, strength));
  }

  get moshStrength(): number {
    return this.uMosh.value;
  }

  setMoshTime(t: number): void {
    this.uMoshTime.value = t;
  }

  /** Bind (or clear) the current hero clip's baked flow texture. Caller owns its lifecycle. */
  setFlow(tex: THREE.Texture | null): void {
    this.uFlowMap.value = tex;
    this.uHasFlow.value = tex ? 1 : 0;
  }

  get flowTexture(): THREE.Texture | null {
    return this.uFlowMap.value;
  }
}

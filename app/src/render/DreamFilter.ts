// app/src/render/DreamFilter.ts
// The dream-filter catalog as one postprocessing Effect: five fragment filters, each gated by a
// strength uniform (0 = passthrough). kaleidoscope + liquid remap UV (mainUv); solarize + melt +
// posterize are colour ops (mainImage). The 6th filter (feedback echo-trails) is stateful and
// lives in the LayerStack render-to-target, not here. Strengths come from dream/filterDirector.

import * as THREE from 'three';
import { Effect } from 'postprocessing';
import type { FilterStrengths } from '../dream/filterDirector';

const DREAM_FILTER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uKaleido;
uniform float uLiquid;
uniform float uSolarize;
uniform float uMelt;
uniform float uPosterize;

const vec3 DF_LUMA = vec3(0.299, 0.587, 0.114);

void mainUv(inout vec2 uv) {
  vec2 w = vec2(sin(uv.y * 8.0 + uTime * 0.6), cos(uv.x * 9.0 + uTime * 0.5));
  uv += w * uLiquid * 0.03;

  vec2 c = uv - 0.5;
  float ang = atan(c.y, c.x);
  float r = length(c);
  float seg = 3.14159265 / 3.0;
  float folded = abs(mod(ang, seg * 2.0) - seg);
  vec2 k = 0.5 + vec2(cos(folded), sin(folded)) * r;
  uv = mix(uv, k, uKaleido);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;

  vec3 solar = mix(col, 1.0 - col, step(0.5, col));
  col = mix(col, solar, uSolarize);

  float levels = 5.0;
  vec3 post = floor(col * levels) / levels;
  col = mix(col, post, uPosterize);

  float l = dot(col, DF_LUMA);
  vec3 melted = clamp(l + (col - l) * 1.8, 0.0, 1.0);
  melted += vec3(0.08, 0.05, 0.0) * smoothstep(0.5, 1.0, l);
  col = mix(col, melted, uMelt);

  outputColor = vec4(clamp(col, 0.0, 1.0), inputColor.a);
}
`;

export class DreamFilter extends Effect {
  constructor() {
    super('DreamFilter', DREAM_FILTER_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uTime', new THREE.Uniform(0)],
        ['uKaleido', new THREE.Uniform(0)],
        ['uLiquid', new THREE.Uniform(0)],
        ['uSolarize', new THREE.Uniform(0)],
        ['uMelt', new THREE.Uniform(0)],
        ['uPosterize', new THREE.Uniform(0)],
      ]),
    });
  }

  setTime(t: number): void {
    (this.uniforms.get('uTime') as THREE.Uniform).value = t;
  }

  setStrengths(s: FilterStrengths): void {
    (this.uniforms.get('uKaleido') as THREE.Uniform).value = s.kaleidoscope;
    (this.uniforms.get('uLiquid') as THREE.Uniform).value = s.liquid;
    (this.uniforms.get('uSolarize') as THREE.Uniform).value = s.solarize;
    (this.uniforms.get('uMelt') as THREE.Uniform).value = s.melt;
    (this.uniforms.get('uPosterize') as THREE.Uniform).value = s.posterize;
  }
}

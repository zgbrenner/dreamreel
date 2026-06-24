// app/src/render/TransitionMaterial.ts
import * as THREE from 'three';
import { TRANSITIONS, type TransitionDef } from './transitions';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function buildFragment(def: TransitionDef): string {
  return /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D from;
    uniform sampler2D to;
    uniform float progress;
    uniform float ratio;

    vec4 getFromColor(vec2 uv) { return texture2D(from, uv); }
    vec4 getToColor(vec2 uv) { return texture2D(to, uv); }

    ${def.glsl}

    void main() {
      gl_FragColor = transition(vUv);
    }
  `;
}

/**
 * A three.js ShaderMaterial that blends two textures (`from` -> `to`) by `progress` using a
 * named gl-transitions-spec shader. Swapping the transition rebuilds the program.
 */
export class TransitionMaterial extends THREE.ShaderMaterial {
  private _transitionName: string;

  constructor(initial = 'fade') {
    const def = TRANSITIONS[initial] ?? TRANSITIONS.fade;
    super({
      uniforms: {
        from: { value: null },
        to: { value: null },
        progress: { value: 0 },
        ratio: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: buildFragment(def),
      depthTest: false,
      depthWrite: false,
    });
    this._transitionName = def.name;
  }

  get transitionName(): string {
    return this._transitionName;
  }

  setTransition(name: string): void {
    const def = TRANSITIONS[name];
    if (!def || def.name === this._transitionName) return;
    this.fragmentShader = buildFragment(def);
    this.needsUpdate = true;
    this._transitionName = def.name;
  }

  setFrom(tex: THREE.Texture | null): void {
    this.uniforms.from.value = tex;
  }
  setTo(tex: THREE.Texture | null): void {
    this.uniforms.to.value = tex;
  }
  setProgress(p: number): void {
    this.uniforms.progress.value = THREE.MathUtils.clamp(p, 0, 1);
  }
  setRatio(r: number): void {
    this.uniforms.ratio.value = r;
  }
}

// DepthLayerMaterial / MoshFeedbackMaterial: the onBeforeCompile injection and uniform plumbing.
// GLSL can't compile in jsdom, so these tests exercise the string surgery and uniform state; the
// real-WebGL guarantee comes from the e2e smoke (the materials render every frame there).
import { describe, it, expect } from 'vitest';
import { DepthLayerMaterial, MoshFeedbackMaterial } from '../../src/render/DreamLayerMaterial';
import * as THREE from 'three';

interface FakeShader {
  uniforms: Record<string, unknown>;
  fragmentShader: string;
}

const STOCK_FRAGMENT = 'void main() {\n#include <map_fragment>\n}';

function compile(mat: DepthLayerMaterial | MoshFeedbackMaterial): FakeShader {
  const shader: FakeShader = { uniforms: {}, fragmentShader: STOCK_FRAGMENT };
  (mat.onBeforeCompile as (s: FakeShader) => void)(shader);
  return shader;
}

describe('DepthLayerMaterial', () => {
  it('injects the depth-displacement prelude around the stock map chunk', () => {
    const shader = compile(new DepthLayerMaterial());
    expect(shader.fragmentShader).toContain('uniform sampler2D uDepthMap;');
    expect(shader.fragmentShader).toContain('vec2 dreamMapUv = vMapUv;');
    expect(shader.fragmentShader).toContain('#define vMapUv dreamMapUv');
    expect(shader.fragmentShader).toContain('#include <map_fragment>'); // stock chunk untouched
    expect(shader.fragmentShader).toContain('#undef vMapUv');
    expect(shader.uniforms.uDepthMap).toBeTruthy();
    expect(shader.uniforms.uParallax).toBeTruthy();
  });

  it('setDepth toggles uHasDepth and never disposes the caller-owned texture', () => {
    const mat = new DepthLayerMaterial();
    const shader = compile(mat);
    const has = shader.uniforms.uHasDepth as { value: number };
    expect(has.value).toBe(0);
    const depth = new THREE.Texture();
    mat.setDepth(depth);
    expect(has.value).toBe(1);
    expect(mat.depthTexture).toBe(depth);
    mat.setDepth(null);
    expect(has.value).toBe(0);
  });

  it('behaves as a MeshBasicMaterial (opacity/blending/map plumbing intact)', () => {
    const mat = new DepthLayerMaterial({ transparent: true, opacity: 0 });
    expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
    mat.opacity = 0.5;
    expect(mat.opacity).toBe(0.5);
    const tex = new THREE.Texture();
    mat.map = tex;
    expect(mat.map).toBe(tex);
  });
});

describe('MoshFeedbackMaterial', () => {
  it('injects the flow-displacement prelude with a procedural fallback branch', () => {
    const shader = compile(new MoshFeedbackMaterial());
    expect(shader.fragmentShader).toContain('uniform float uMosh;');
    expect(shader.fragmentShader).toContain('uHasFlow');
    expect(shader.fragmentShader).toContain('#define vMapUv dreamMapUv');
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
  });

  it('setMosh clamps to 0..1 and setFlow toggles uHasFlow', () => {
    const mat = new MoshFeedbackMaterial();
    const shader = compile(mat);
    mat.setMosh(2);
    expect(mat.moshStrength).toBe(1);
    mat.setMosh(-1);
    expect(mat.moshStrength).toBe(0);
    const hasFlow = shader.uniforms.uHasFlow as { value: number };
    const flow = new THREE.Texture();
    mat.setFlow(flow);
    expect(hasFlow.value).toBe(1);
    expect(mat.flowTexture).toBe(flow);
    mat.setFlow(null);
    expect(hasFlow.value).toBe(0);
  });
});

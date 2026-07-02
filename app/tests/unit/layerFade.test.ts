// app/tests/unit/layerFade.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';

// LayerStack needs a Compositor-like host; construct a minimal stub exposing scene + camera.
function stubCompositor() {
  const scene = new THREE.Scene();
  return {
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    addOverlay: (m: THREE.Object3D) => scene.add(m),
    removeOverlay: (m: THREE.Object3D) => scene.remove(m),
    addResizeListener: (_fn: (w: number, h: number) => void) => () => {},
    size: { width: 2, height: 2 },
    renderer: {} as unknown,
  };
}

describe('LayerStack swap fade-in', () => {
  it('a freshly-set layer ramps opacity up from 0 over time, not an instant cut', () => {
    const stack = new LayerStack(stubCompositor() as never);
    const tex = new THREE.Texture();
    tex.userData.ownedByCompositor = false;
    stack.setLayerTexture(0, tex);
    stack.applyPlan({ layerCount: 1, blends: ['screen'], feedback: 0, warp: 0 } as never);
    // immediately after swap: near 0
    stack.update(0); // settle visibility
    const mat0 = (stack as unknown as { mats: THREE.MeshBasicMaterial[] }).mats[0];
    const early = mat0.opacity;
    stack.update(0.5); // half a second later -> approaching target
    const later = mat0.opacity;
    expect(early).toBeLessThan(0.5);
    expect(later).toBeGreaterThan(early);
  });

  it('setHeroCap scales the hero fade target (hypnagogic onset), default 1 leaves 0.92', () => {
    const stack = new LayerStack(stubCompositor() as never);
    const tex = new THREE.Texture();
    tex.userData.ownedByCompositor = false;
    stack.setLayerTexture(0, tex);
    const plan = { layerCount: 1, blends: ['screen'], feedback: 0, warp: 0 } as never;
    const targets = (stack as unknown as { fadeTarget: number[] }).fadeTarget;

    stack.applyPlan(plan);
    expect(targets[0]).toBeCloseTo(0.92);

    stack.setHeroCap(0.5);
    stack.applyPlan(plan);
    expect(targets[0]).toBeCloseTo(0.46);

    stack.setHeroCap(1);
    stack.applyPlan(plan);
    expect(targets[0]).toBeCloseTo(0.92);
  });
});

describe('LayerStack resize wiring', () => {
  it('resizes its feedback targets when the compositor fires a resize', () => {
    let fire: ((w: number, h: number) => void) | null = null;
    const scene = new THREE.Scene();
    const stub = {
      scene,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      addOverlay: (m: THREE.Object3D) => scene.add(m),
      removeOverlay: (m: THREE.Object3D) => scene.remove(m),
      addResizeListener: (fn: (w: number, h: number) => void) => {
        fire = fn;
        return () => {
          fire = null;
        };
      },
      size: { width: 2, height: 2 },
      renderer: {} as unknown,
    };
    const stack = new LayerStack(stub as never);
    const fbA = (stack as unknown as { fbA: THREE.WebGLRenderTarget }).fbA;
    // constructed at half(2) = 1
    expect(fbA.width).toBe(1);
    expect(fire).not.toBeNull();
    fire!(800, 600); // simulate a window resize
    // targets render at half resolution
    expect(fbA.width).toBe(400);
    expect(fbA.height).toBe(300);
  });
});

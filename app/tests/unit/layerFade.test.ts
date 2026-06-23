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
});

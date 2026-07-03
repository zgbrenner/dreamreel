// LayerStack gl-transition overlay for calm hero swaps: the state machine + texture plumbing.
// GLSL compilation is covered by tests/e2e/transitions-compile.spec.ts (all TRANSITIONS render in
// real WebGL); here we exercise begin/advance/settle and the hero-texture bookkeeping.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';

function stubCompositor() {
  const scene = new THREE.Scene();
  return {
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    addOverlay: (m: THREE.Object3D) => scene.add(m),
    removeOverlay: (m: THREE.Object3D) => scene.remove(m),
    addResizeListener: (_fn: (w: number, h: number) => void) => () => {},
    size: { width: 16, height: 9 },
    renderer: {} as unknown,
  };
}

function tex(): THREE.Texture {
  const t = new THREE.Texture();
  t.userData.ownedByCompositor = false;
  return t;
}

describe('LayerStack gl-transition overlay', () => {
  it('currentHeroTexture returns the newest visible slot, null when empty', () => {
    const stack = new LayerStack(stubCompositor() as never);
    expect(stack.currentHeroTexture()).toBeNull();
    const a = tex();
    const b = tex();
    stack.setLayerTexture(0, a);
    stack.applyPlan({ layerCount: 1, blends: ['normal'], feedback: 0, warp: 0 } as never);
    expect(stack.currentHeroTexture()).toBe(a);
    stack.setLayerTexture(1, b); // newer writeSeq
    stack.applyPlan({ layerCount: 2, blends: ['normal', 'screen'], feedback: 0, warp: 0 } as never);
    expect(stack.currentHeroTexture()).toBe(b);
  });

  it('beginTransition engages, advances by dt, and settles at progress 1', () => {
    const stack = new LayerStack(stubCompositor() as never);
    const from = tex();
    const to = tex();
    expect(stack.transitionInFlight).toBe(false);
    stack.beginTransition(from, to, 'crossLuma', 0.5);
    expect(stack.transitionInFlight).toBe(true);

    stack.update(0.25); // halfway
    expect(stack.transitionInFlight).toBe(true);
    stack.update(0.3); // past the end -> settles
    expect(stack.transitionInFlight).toBe(false);
  });

  it('is a no-op for a null/equal texture or non-positive duration (fade stays in charge)', () => {
    const stack = new LayerStack(stubCompositor() as never);
    const a = tex();
    stack.beginTransition(null, a, 'fade', 0.5);
    expect(stack.transitionInFlight).toBe(false);
    stack.beginTransition(a, a, 'fade', 0.5); // same texture
    expect(stack.transitionInFlight).toBe(false);
    stack.beginTransition(a, tex(), 'fade', 0); // zero duration
    expect(stack.transitionInFlight).toBe(false);
  });

  it('does not throw disposing while a transition holds only caller-owned texture refs', () => {
    const stack = new LayerStack(stubCompositor() as never);
    stack.beginTransition(tex(), tex(), 'swirl', 0.6);
    expect(() => stack.dispose()).not.toThrow();
  });
});

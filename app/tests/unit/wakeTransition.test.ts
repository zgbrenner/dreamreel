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

describe('LayerStack Ken Burns drift', () => {
  it('advances zoom + pan on a visible slot, keeping |pan| < zoom/2 (no edge sampling)', () => {
    const stack = new LayerStack(stubCompositor() as never);
    stack.setLayerTexture(0, tex());
    stack.applyPlan({ layerCount: 1, blends: ['normal'], feedback: 0, warp: 0 } as never);
    stack.setKenBurns(0, 0, 0.012); // pan along +x
    const mat = (stack as unknown as { mats: { uKen?: unknown }[] }).mats[0] as unknown as {
      setKen: (x: number, y: number, z: number) => void;
    } & { [k: string]: unknown };
    // Reach into the material's uKen via a spy: drive several seconds and read the last write.
    let last = { x: 0, y: 0, z: 0 };
    (mat as unknown as { setKen: (x: number, y: number, z: number) => void }).setKen = (x, y, z) => {
      last = { x, y, z };
    };
    for (let i = 0; i < 200; i++) stack.update(0.05); // ~10 s
    expect(last.z).toBeGreaterThan(0); // zoomed in
    expect(last.z).toBeLessThanOrEqual(0.14); // capped
    expect(Math.abs(last.x)).toBeLessThan(last.z / 2); // pan stays inside the frame
  });

  it('rate 0 leaves the slot at identity (no Ken Burns, no regression)', () => {
    const stack = new LayerStack(stubCompositor() as never);
    stack.setLayerTexture(0, tex());
    stack.applyPlan({ layerCount: 1, blends: ['normal'], feedback: 0, warp: 0 } as never);
    stack.setKenBurns(0, 1.2, 0); // rate 0 → disabled
    let touched = false;
    const mat = (stack as unknown as { mats: unknown[] }).mats[0] as {
      setKen: (x: number, y: number, z: number) => void;
    };
    mat.setKen = () => {
      touched = true;
    };
    for (let i = 0; i < 40; i++) stack.update(0.05);
    expect(touched).toBe(false);
  });
});

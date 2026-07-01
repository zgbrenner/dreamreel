// app/tests/unit/layerPin.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';
function stub() { const s = new THREE.Scene(); return { scene: s, camera: new THREE.OrthographicCamera(-1,1,1,-1,0,1), addOverlay:(m:THREE.Object3D)=>s.add(m), removeOverlay:(m:THREE.Object3D)=>s.remove(m), addResizeListener:(_fn:(w:number,h:number)=>void)=>()=>{}, size:{width:2,height:2}, renderer:{} as unknown }; }

describe('LayerStack pin', () => {
  it('a pinned slot stays visible even when newer swaps would rank it out', () => {
    const stack = new LayerStack(stub() as never);
    const layers = (stack as unknown as { layers: THREE.Mesh[] }).layers;
    // slot 0 is the pinned (old) video; fill newer slots 1..3
    for (let i = 0; i < 4; i++) { const t = new THREE.Texture(); t.userData.ownedByCompositor=false; stack.setLayerTexture(i, t); }
    // plan shows only 2 layers; without a pin, slot 0 (oldest) would be hidden
    stack.applyPlan({ layerCount: 2, blends: ['screen','screen','screen','screen'], feedback:0, warp:0 } as never, new Set([0]));
    expect(layers[0].visible).toBe(true); // pinned stays on
  });

  it('a pinned non-hero slot has prominent opacity (>= 0.7) after fade completes', () => {
    const stack = new LayerStack(stub() as never);
    const mats = (stack as unknown as { mats: THREE.MeshBasicMaterial[] }).mats;
    // Fill 4 slots in order: slot 0 oldest, slot 3 newest (hero)
    for (let i = 0; i < 4; i++) { const t = new THREE.Texture(); t.userData.ownedByCompositor=false; stack.setLayerTexture(i, t); }
    // plan shows 3 layers; pin the oldest (slot 0) so it's visible but not hero
    const plan = { layerCount: 3, blends: ['screen','screen','screen','screen'], feedback:0, warp:0 } as never;
    stack.applyPlan(plan, new Set([0]));
    // advance fade fully (large dt so factor -> 1)
    stack.update(1);
    // pinned non-hero (slot 0) must be prominent
    expect(mats[0].opacity).toBeGreaterThanOrEqual(0.7);
    // a non-pinned non-hero visible slot (slot 2, rank 1) should be lower
    expect(mats[2].opacity).toBeLessThan(0.7);
  });

  it('a one-layer focused plan hides newer overlays and leaves the pinned video visible', () => {
    const stack = new LayerStack(stub() as never);
    const layers = (stack as unknown as { layers: THREE.Mesh[] }).layers;
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Texture();
      t.userData.ownedByCompositor = false;
      stack.setLayerTexture(i, t);
    }

    stack.applyPlan({ layerCount: 1, blends: ['normal'], feedback: 0, warp: 0 } as never, new Set([0]));

    expect(layers[0].visible).toBe(true);
    expect(layers[1].visible).toBe(false);
    expect(layers[2].visible).toBe(false);
    expect(layers[3].visible).toBe(false);
  });
});

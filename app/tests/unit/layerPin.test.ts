// app/tests/unit/layerPin.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LayerStack } from '../../src/render/LayerStack';
function stub() { const s = new THREE.Scene(); return { scene: s, camera: new THREE.OrthographicCamera(-1,1,1,-1,0,1), addOverlay:(m:THREE.Object3D)=>s.add(m), removeOverlay:(m:THREE.Object3D)=>s.remove(m), size:{width:2,height:2}, renderer:{} as unknown }; }

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
});

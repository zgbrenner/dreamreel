// app/src/render/LayerStack.ts
//
// Grows the compositor from its two fixed layers (stage + ghost) to N (<= MAX_LAYERS)
// blended quads plus a feedback buffer for trails, driven by a LayerPlan. Pure render
// plumbing — the LayerPlan that drives it is computed elsewhere (dream/layerPlan.ts).
//
// This module is standalone for now: wiring it into Compositor/conductor (including the
// full render-to-target feedback ping-pong) happens in Task 7. Verified against three.js
// 0.169.0: NormalBlending / AdditiveBlending / MultiplyBlending and the WebGLRenderTarget
// (.texture getter, .setSize) APIs all exist in that version.

import * as THREE from 'three';
import { MAX_LAYERS, type LayerPlan, type BlendName } from '../dream/layerPlan';
import type { Compositor } from './Compositor';

// three.js has no true Photoshop "screen"/"lighten"/"overlay" blend modes built in.
// Additive is a faithful-enough stand-in for screen/lighten (both brighten toward white);
// "overlay" has no safe built-in (CustomBlending without configured factors renders wrong),
// so it maps to NormalBlending — correct and simple. Real overlay would need a shader.
const BLEND_MAP: Record<BlendName, THREE.Blending> = {
  normal: THREE.NormalBlending,
  screen: THREE.AdditiveBlending,
  lighten: THREE.AdditiveBlending,
  multiply: THREE.MultiplyBlending,
  overlay: THREE.NormalBlending,
};

const half = (n: number): number => Math.max(1, Math.floor(n / 2));

export class LayerStack {
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly layers: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshBasicMaterial[] = [];
  private feedback = 0;
  private fbA: THREE.WebGLRenderTarget;
  private fbB: THREE.WebGLRenderTarget;
  private readonly fbMat: THREE.MeshBasicMaterial;

  constructor(compositor: Compositor) {
    const { width, height } = compositor.size;
    this.fbA = new THREE.WebGLRenderTarget(half(width), half(height));
    this.fbB = new THREE.WebGLRenderTarget(half(width), half(height));

    for (let i = 0; i < MAX_LAYERS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      // Sit above the compositor's stage (renderOrder 0) and ghost (renderOrder 1); the
      // feedback quad (renderOrder 9) renders just beneath the layer fan.
      mesh.renderOrder = 10 + i;
      mesh.visible = false;
      this.mats.push(mat);
      this.layers.push(mesh);
      compositor.addOverlay(mesh);
    }

    this.fbMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const fbMesh = new THREE.Mesh(this.quad, this.fbMat);
    fbMesh.frustumCulled = false;
    fbMesh.renderOrder = 9;
    compositor.addOverlay(fbMesh);
  }

  /**
   * Bind a texture to layer `index`. If the previous texture was compositor-owned and is
   * being replaced, recycle it (procedural/shared textures are owned elsewhere — left alone).
   */
  setLayerTexture(index: number, tex: THREE.Texture): void {
    if (index < 0 || index >= MAX_LAYERS) return;
    const mat = this.mats[index];
    const prev = mat.map;
    if (prev && prev !== tex && prev.userData.ownedByCompositor) prev.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
  }

  /** Apply a LayerPlan: toggle/visibility, blend mode, opacity falloff, and trail strength. */
  applyPlan(plan: LayerPlan): void {
    this.feedback = plan.feedback;
    this.fbMat.opacity = plan.feedback * 0.9;
    for (let i = 0; i < MAX_LAYERS; i++) {
      const on = i < plan.layerCount;
      this.layers[i].visible = on && this.mats[i].map !== null;
      if (on) {
        this.mats[i].blending = BLEND_MAP[plan.blends[i] ?? 'screen'];
        this.mats[i].opacity = i === 0 ? 0.95 : Math.max(0.25, 0.8 - i * 0.08);
      }
    }
  }

  resize(width: number, height: number): void {
    this.fbA.setSize(half(width), half(height));
    this.fbB.setSize(half(width), half(height));
  }

  /**
   * Advance the feedback ping-pong: swap the read/write targets and point the feedback quad
   * at the freshly-read target so trails persist across frames.
   *
   * NOTE: this simplified version only swaps targets and rebinds the texture. The full
   * render-to-target capture (rendering the current frame into `fbB` via the renderer, so
   * the trail actually accumulates GPU-side) is wired in Task 7 tuning — hence `_renderer`
   * is accepted but unused here.
   */
  captureFeedback(_renderer: THREE.WebGLRenderer): void {
    if (this.feedback <= 0.01) return;
    const tmp = this.fbA;
    this.fbA = this.fbB;
    this.fbB = tmp;
    this.fbMat.map = this.fbA.texture;
    this.fbMat.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.mats) {
      if (m.map && m.map.userData.ownedByCompositor) m.map.dispose();
      m.dispose();
    }
    if (this.fbMat.map && this.fbMat.map.userData.ownedByCompositor) this.fbMat.map.dispose();
    this.fbMat.dispose();
    this.fbA.dispose();
    this.fbB.dispose();
    this.quad.dispose();
  }
}

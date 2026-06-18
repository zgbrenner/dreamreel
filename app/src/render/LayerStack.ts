// app/src/render/LayerStack.ts
//
// Grows the compositor from its two fixed layers (stage + ghost) to N (<= MAX_LAYERS)
// blended quads plus a feedback buffer for trails, driven by a LayerPlan. Pure render
// plumbing — the LayerPlan that drives it is computed elsewhere (dream/layerPlan.ts).
//
// Wired into the compositor by the conductor's wake scheduler (dream/conductor.ts), which
// computes the LayerPlan and drives applyPlan/setLayerTexture each swap. The feedback
// render-to-target ping-pong (melancholy echo-trails) is implemented in captureFeedback below.
// Verified against three.js 0.169.0: NormalBlending / AdditiveBlending / MultiplyBlending
// and the WebGLRenderTarget (.texture getter, .setSize) APIs all exist in that version.

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
  private feedbackTrail = 0; // melancholy echo-trail strength, 0..1 (set by the conductor)
  // Per-slot write order, so applyPlan can show the MOST RECENT images (the newest is the
  // opaque "hero"; older ones fan behind it) rather than a fixed slot range — otherwise a
  // freshly-swapped image often lands in a hidden slot and the media never reads.
  private readonly writeSeq = new Array<number>(MAX_LAYERS).fill(0);
  private seqCounter = 0;
  private fbA: THREE.WebGLRenderTarget;
  private fbB: THREE.WebGLRenderTarget;
  private readonly fbMat: THREE.MeshBasicMaterial;
  private readonly fbMesh: THREE.Mesh;
  private readonly compositor: Compositor;

  constructor(compositor: Compositor) {
    this.compositor = compositor;
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
    this.fbMesh = fbMesh;
    compositor.addOverlay(fbMesh);
  }

  /** Echo-trail strength for the melancholy "feedback" filter (0 = off). */
  setFeedback(amount: number): void {
    this.feedbackTrail = Math.max(0, Math.min(1, amount));
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
    this.writeSeq[index] = ++this.seqCounter;
  }

  /**
   * Apply a LayerPlan. Shows the `layerCount` MOST-RECENTLY-written layers (by writeSeq): the
   * newest is a near-opaque NormalBlending "hero" so the current image always reads clearly;
   * older ones fan behind it, additively/blended and fading with age, for the dense collage.
   */
  applyPlan(plan: LayerPlan): void {
    // Feedback trail strength is owned solely by setFeedback() now (the director's single source
    // of truth), so applyPlan no longer touches fbMat — two sources must not fight over it.

    // Slots that hold a texture, newest first.
    const ranked = [];
    for (let i = 0; i < MAX_LAYERS; i++) if (this.mats[i].map !== null) ranked.push(i);
    ranked.sort((a, b) => this.writeSeq[b] - this.writeSeq[a]);

    const visibleCount = Math.min(plan.layerCount, ranked.length);
    for (let i = 0; i < MAX_LAYERS; i++) this.layers[i].visible = false;
    for (let rank = 0; rank < visibleCount; rank++) {
      const slot = ranked[rank];
      this.layers[slot].visible = true;
      const mat = this.mats[slot];
      if (rank === 0) {
        mat.blending = THREE.NormalBlending; // hero: the current image, mostly opaque
        mat.opacity = 0.92;
      } else {
        mat.blending = BLEND_MAP[plan.blends[rank] ?? 'screen'];
        mat.opacity = Math.max(0.18, 0.6 - rank * 0.09);
      }
    }
  }

  resize(width: number, height: number): void {
    this.fbA.setSize(half(width), half(height));
    this.fbB.setSize(half(width), half(height));
  }

  /**
   * Advance the feedback ping-pong. Renders the composited scene into the write target (fbB) and
   * binds the previous capture (fbA) onto the feedback quad. Because fbMesh (renderOrder 9) is
   * itself in the scene, each capture folds last frame's echo back in — that recursion IS the
   * accumulating trail. Called inside wakeTick, which runs as a frame listener BEFORE the
   * compositor's renderFrame (the post-FX composer.render); we save/restore the active render
   * target so the composer pass is unaffected. When trail strength is 0 the quad is hidden and
   * no extra render happens, so the output is byte-identical to feedback-off / classic mode.
   */
  captureFeedback(renderer: THREE.WebGLRenderer): void {
    this.fbMat.opacity = this.feedbackTrail * 0.85;
    this.fbMesh.visible = this.feedbackTrail > 0.01;
    if (this.feedbackTrail <= 0.01) return;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.fbB);
    renderer.render(this.compositor.scene, this.compositor.camera);
    renderer.setRenderTarget(prevTarget);

    const tmp = this.fbA;
    this.fbA = this.fbB;
    this.fbB = tmp;
    this.fbMat.map = this.fbA.texture;
    this.fbMat.needsUpdate = true;
  }

  dispose(): void {
    // Detach the layer + feedback meshes from the compositor scene so dispose() doesn't leave
    // dead meshes rendering (Compositor has no removeOverlay otherwise — added in Task 7).
    for (const mesh of this.layers) this.compositor.removeOverlay(mesh);
    this.compositor.removeOverlay(this.fbMesh);
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

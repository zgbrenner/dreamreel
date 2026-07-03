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
import { DepthLayerMaterial, MoshFeedbackMaterial } from './DreamLayerMaterial';
import { TransitionMaterial } from './TransitionMaterial';
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
  private readonly mats: DepthLayerMaterial[] = [];
  // Presentation-only scale on the hero layer's resting opacity (0..1). The hypnagogic onset
  // eases it 0.5 → 1 so the opening imagery reads as translucent fragments cohering into a scene.
  private heroCap = 1;
  private fadeRate = 3; // per-second cross-fade ease; mood-shaped via setFadeRate
  private feedbackTrail = 0; // melancholy echo-trail strength, 0..1 (set by the conductor)
  // Per-slot write order, so applyPlan can show the MOST RECENT images (the newest is the
  // opaque "hero"; older ones fan behind it) rather than a fixed slot range — otherwise a
  // freshly-swapped image often lands in a hidden slot and the media never reads.
  private readonly writeSeq = new Array<number>(MAX_LAYERS).fill(0);
  private seqCounter = 0;
  // Per-slot opacity fade: applyPlan writes desired opacities into fadeTarget; update(dt)
  // eases fadeOpacity toward fadeTarget (~0.3 s) and writes mat.opacity. setLayerTexture
  // resets fadeOpacity[slot] to 0 so a new texture always fades in instead of hard-cutting.
  private readonly fadeOpacity = new Array<number>(MAX_LAYERS).fill(0);
  private readonly fadeTarget = new Array<number>(MAX_LAYERS).fill(0);
  private fbA: THREE.WebGLRenderTarget;
  private fbB: THREE.WebGLRenderTarget;
  private readonly fbMat: MoshFeedbackMaterial;
  private readonly fbMesh: THREE.Mesh;
  // Optional psychedelic (Butterchurn) overlay — sits above the whole fan, additively blended.
  // Hidden by default; when no texture/opacity is set it renders nothing, so output is identical
  // to the layer stack without it (the base reel is never touched by this path).
  private readonly psychMat: THREE.MeshBasicMaterial;
  private readonly psychMesh: THREE.Mesh;
  // gl-transition overlay for CALM hero swaps: a mood-selected wipe from the outgoing hero to the
  // incoming, rendered above the fan (renderOrder 17.5, below psych/ghost). Engaged only on
  // single-hero swaps (the conductor gates it), so it never covers the dense collage — where a
  // wipe would fight the layering and the opacity cross-fade is kept instead.
  private readonly transitionMat = new TransitionMaterial('fade');
  private readonly transitionMesh: THREE.Mesh;
  private transitionActive = false;
  private transitionElapsed = 0;
  private transitionDuration = 0;
  private readonly compositor: Compositor;
  private readonly unsubResize: () => void;

  constructor(compositor: Compositor) {
    this.compositor = compositor;
    const { width, height } = compositor.size;
    this.fbA = new THREE.WebGLRenderTarget(half(width), half(height));
    this.fbB = new THREE.WebGLRenderTarget(half(width), half(height));
    // Keep the feedback targets in sync with the canvas; otherwise they stay frozen at the
    // construction-time size and a window resize stretches the echo-trail buffer.
    this.unsubResize = compositor.addResizeListener((w, h) => this.resize(w, h));

    for (let i = 0; i < MAX_LAYERS; i++) {
      // DepthLayerMaterial === MeshBasicMaterial unless a baked depth map is bound (2.5D drift).
      const mat = new DepthLayerMaterial({
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

    // MoshFeedbackMaterial === MeshBasicMaterial at uMosh 0; nightmare surges smear the trail
    // along baked/procedural flow (the datamosh path — see DreamLayerMaterial).
    this.fbMat = new MoshFeedbackMaterial({
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

    // Psychedelic overlay quad: above the entire layer fan (renderOrder 10..10+MAX_LAYERS-1).
    this.psychMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const psychMesh = new THREE.Mesh(this.quad, this.psychMat);
    psychMesh.frustumCulled = false;
    psychMesh.renderOrder = 10 + MAX_LAYERS;
    psychMesh.visible = false;
    this.psychMesh = psychMesh;
    compositor.addOverlay(psychMesh);

    this.transitionMat.setRatio(width / height);
    const transitionMesh = new THREE.Mesh(this.quad, this.transitionMat);
    transitionMesh.frustumCulled = false;
    transitionMesh.renderOrder = MAX_LAYERS + 9.5; // above the fan (≤17), below psych(18)/ghost(19)
    transitionMesh.visible = false;
    this.transitionMesh = transitionMesh;
    compositor.addOverlay(transitionMesh);
  }

  /** The texture currently shown as hero (highest-writeSeq visible slot), or null. */
  currentHeroTexture(): THREE.Texture | null {
    let best = -1;
    let tex: THREE.Texture | null = null;
    for (let i = 0; i < MAX_LAYERS; i++) {
      if (this.layers[i].visible && this.mats[i].map && this.writeSeq[i] > best) {
        best = this.writeSeq[i];
        tex = this.mats[i].map;
      }
    }
    return tex;
  }

  /**
   * Begin a gl-transition wipe from `from` to `to` over `durationSec`, using the named
   * mood-selected shader. Neither texture is owned/disposed here (the caller owns them; both stay
   * alive for the brief transition). A null `from` or `to`, or a zero duration, is a no-op that
   * leaves the plain opacity cross-fade in charge.
   */
  beginTransition(
    from: THREE.Texture | null,
    to: THREE.Texture | null,
    name: string,
    durationSec: number,
  ): void {
    if (!from || !to || from === to || durationSec <= 0) return;
    const { width, height } = this.compositor.size;
    this.transitionMat.setTransition(name);
    this.transitionMat.setFrom(from);
    this.transitionMat.setTo(to);
    this.transitionMat.setProgress(0);
    this.transitionMat.setRatio(width / height);
    this.transitionMesh.visible = true;
    this.transitionActive = true;
    this.transitionElapsed = 0;
    this.transitionDuration = durationSec;
  }

  private endTransition(): void {
    this.transitionActive = false;
    this.transitionMesh.visible = false;
    // Release the texture refs so a settled transition never pins a recycled texture alive.
    this.transitionMat.setFrom(null);
    this.transitionMat.setTo(null);
  }

  /**
   * Bind (or clear) the optional psychedelic overlay texture and its blend opacity. Pass a null
   * texture or opacity <= 0 to hide it entirely — when hidden it contributes nothing to the frame,
   * so the base reel is byte-identical to the no-overlay path. Not compositor-owned; the caller
   * (ButterchurnLayer) owns the texture's lifecycle.
   */
  setPsychedelic(tex: THREE.Texture | null, opacity: number): void {
    const op = Math.max(0, Math.min(1, opacity));
    if (!tex || op <= 0) {
      this.psychMesh.visible = false;
      this.psychMat.opacity = 0;
      this.psychMat.map = null;
      return;
    }
    if (this.psychMat.map !== tex) {
      this.psychMat.map = tex;
      this.psychMat.needsUpdate = true;
    }
    this.psychMat.opacity = op;
    this.psychMesh.visible = true;
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
    mat.setDepth(null); // a new texture starts flat; setLayerDepth re-binds when its map arrives
    mat.needsUpdate = true;
    this.writeSeq[index] = ++this.seqCounter;
    this.fadeOpacity[index] = 0; // new texture fades in rather than hard-cutting
  }

  /**
   * Bind a baked depth map to a slot for 2.5D parallax — guarded by `expectMap`: depth loads are
   * async, so by the time one arrives the slot may already show a different texture. The depth
   * texture is cached and owned by the conductor; never disposed here.
   */
  setLayerDepth(index: number, depth: THREE.Texture | null, expectMap: THREE.Texture): void {
    if (index < 0 || index >= MAX_LAYERS) return;
    const mat = this.mats[index];
    if (mat.map !== expectMap) return; // slot moved on — stale depth, drop it
    mat.setDepth(depth);
  }

  /** Presentation-only parallax offset applied to every depth-bound layer (UV units, small). */
  setParallax(x: number, y: number): void {
    for (const mat of this.mats) mat.setParallax(x, y);
  }

  /** Datamosh smear strength for the feedback trail (0 = stock; surge-gated by the conductor). */
  setMosh(strength: number, timeSec: number): void {
    this.fbMat.setMosh(strength);
    this.fbMat.setMoshTime(timeSec);
  }

  /** Bind (or clear) the current hero clip's baked flow texture for the mosh smear direction. */
  setMoshFlow(tex: THREE.Texture | null): void {
    this.fbMat.setFlow(tex);
  }

  /** Presentation-only cap on the hero layer's opacity (clamped 0..1; default 1 = unchanged). */
  setHeroCap(cap: number): void {
    this.heroCap = Math.max(0, Math.min(1, cap));
  }

  /**
   * Apply a LayerPlan. Shows the `layerCount` MOST-RECENTLY-written layers (by writeSeq): the
   * newest is a near-opaque NormalBlending "hero" so the current image always reads clearly;
   * older ones fan behind it, additively/blended and fading with age, for the dense collage.
   */
  applyPlan(plan: LayerPlan, pinnedSlots?: ReadonlySet<number>): void {
    // Feedback trail strength is owned solely by setFeedback() now (the director's single source
    // of truth), so applyPlan no longer touches fbMat — two sources must not fight over it.

    // Slots that hold a texture, newest first.
    const ranked = [];
    for (let i = 0; i < MAX_LAYERS; i++) if (this.mats[i].map !== null) ranked.push(i);
    ranked.sort((a, b) => this.writeSeq[b] - this.writeSeq[a]);

    // Pinned slots (e.g. a playing video held by the conductor) are prepended to the ranking so
    // they are always included in the visible set — a held clip can't be ranked out of view as
    // newer swaps fire. Only pinned slots that actually hold a texture are promoted.
    const pin = pinnedSlots ?? new Set<number>();
    const pinnedWithTex = ranked.filter((i) => pin.has(i));
    const rest = ranked.filter((i) => !pin.has(i));
    const finalRanked = [...pinnedWithTex, ...rest];

    const visibleCount = Math.min(plan.layerCount, finalRanked.length);
    for (let i = 0; i < MAX_LAYERS; i++) {
      this.layers[i].visible = false;
      this.fadeTarget[i] = 0;
    }
    for (let rank = 0; rank < visibleCount; rank++) {
      const slot = finalRanked[rank];
      this.layers[slot].visible = true;
      const mat = this.mats[slot];
      if (rank === 0) {
        mat.blending = THREE.NormalBlending; // hero: the current image, mostly opaque
        this.fadeTarget[slot] = 0.92 * this.heroCap;
      } else {
        mat.blending = BLEND_MAP[plan.blends[rank] ?? 'screen'];
        let target = Math.max(0.18, 0.6 - rank * 0.09);
        if (pin.has(slot)) target = Math.max(target, 0.72);
        this.fadeTarget[slot] = target;
      }
    }
  }

  /**
   * Advance per-slot opacity ramps toward their targets (~0.3 s ease). Must be called each
   * frame (from conductor `wakeTick`) BEFORE rendering so material opacity is current.
   * A freshly-set texture starts at fadeOpacity=0 (reset in setLayerTexture) and ramps up,
   * eliminating the hard-cut flicker on layer swaps.
   */
  /** Mood-shaped cross-fade ease rate (per second; filterDirector.swapFadeRate). Default 3. */
  setFadeRate(rate: number): void {
    this.fadeRate = Math.max(0.5, Math.min(12, rate));
  }

  update(dtSec: number): void {
    const factor = Math.min(1, dtSec * this.fadeRate); // rate 3 ≈ 0.8 s dissolve (the default)
    for (let i = 0; i < MAX_LAYERS; i++) {
      this.fadeOpacity[i] += (this.fadeTarget[i] - this.fadeOpacity[i]) * factor;
      this.mats[i].opacity = this.fadeOpacity[i];
    }
    // Advance the gl-transition overlay (calm hero swaps); the underlying fade also runs so the
    // settled hero is already at full opacity when the overlay hides — a seamless handoff.
    if (this.transitionActive) {
      this.transitionElapsed += dtSec;
      const p = this.transitionElapsed / this.transitionDuration;
      if (p >= 1) this.endTransition();
      else this.transitionMat.setProgress(p);
    }
  }

  /** True while a gl-transition wipe is playing (exposed for the conductor + tests). */
  get transitionInFlight(): boolean {
    return this.transitionActive;
  }

  resize(width: number, height: number): void {
    this.fbA.setSize(half(width), half(height));
    this.fbB.setSize(half(width), half(height));
    this.transitionMat.setRatio(width / height);
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
    this.fbMat.opacity = this.feedbackTrail * 0.55;
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
    this.unsubResize();
    // Detach the layer + feedback meshes from the compositor scene so dispose() doesn't leave
    // dead meshes rendering via the compositor's removeOverlay.
    for (const mesh of this.layers) this.compositor.removeOverlay(mesh);
    this.compositor.removeOverlay(this.fbMesh);
    this.compositor.removeOverlay(this.psychMesh);
    this.compositor.removeOverlay(this.transitionMesh);
    this.transitionMat.dispose(); // holds no owned textures (from/to are caller-owned refs)
    for (const m of this.mats) {
      if (m.map && m.map.userData.ownedByCompositor) m.map.dispose();
      m.dispose();
    }
    if (this.fbMat.map && this.fbMat.map.userData.ownedByCompositor) this.fbMat.map.dispose();
    this.fbMat.dispose();
    // The psych texture is owned by ButterchurnLayer (not compositor-owned), so only drop the material.
    this.psychMat.dispose();
    this.fbA.dispose();
    this.fbB.dispose();
    this.quad.dispose();
  }
}

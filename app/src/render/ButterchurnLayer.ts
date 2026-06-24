// app/src/render/ButterchurnLayer.ts
//
// An optional psychedelic dream layer rendered by Butterchurn (a WebGL Milkdrop visualizer; both
// `butterchurn` and `butterchurn-presets` are MIT — see app/NOTICE). It engages ONLY during
// high-intensity "frenzy" regimes (decided by dream/filterDirector.butterchurnEngaged) to give
// those moments an ever-changing, audio-reactive surreal wash, then disengages so the base reel
// resumes.
//
// ── Loading + safety ───────────────────────────────────────────────────────────────────────────
//   • The packages are LAZILY code-split: `import('butterchurn')` only runs on the first engage,
//     so they never bloat the default bundle (the layer is off unless ?butterchurn=1).
//   • Butterchurn is browser-only (it touches `window`/WebGL2 at load), so it is NEVER imported at
//     module top level — keeping tests / non-DOM environments clean.
//   • Everything is guarded: a missing WebGL2 context, a load failure, or any throw leaves
//     `texture` null and the base reel completely unaffected — it can never break the dream.
//   • LICENSE note: `butterchurn-presets` is MIT, but the bundled Milkdrop presets are
//     community-authored; their upstream provenance is documented in app/NOTICE for the
//     commercial-ship decision. The layer stays default-OFF until that call is made.

import * as THREE from 'three';
import type { ButterchurnVisualizer } from 'butterchurn';

export interface ButterchurnLayerOptions {
  width?: number;
  height?: number;
}

/**
 * A lazily-initialized Butterchurn visualizer wrapped as a THREE texture source. Construction is
 * cheap and synchronous; the heavy WebGL/library load happens on the first `engage(true)` (once an
 * audio context has been attached) and is fully guarded. `texture` is null until — and unless — it
 * initializes successfully.
 */
export class ButterchurnLayer {
  private readonly canvas: HTMLCanvasElement | null;
  private _texture: THREE.CanvasTexture | null = null;
  private viz: ButterchurnVisualizer | null = null;
  private presets: unknown[] = [];
  private engaged = false;
  private loading = false;
  private failed = false;
  private readonly width: number;
  private readonly height: number;
  private audioContext: unknown = null;
  private audioNode: unknown = null;

  constructor(opts: ButterchurnLayerOptions = {}) {
    this.width = opts.width ?? 512;
    this.height = opts.height ?? 288;
    // Guard for non-DOM (tests) — no canvas means this stays a permanent no-op.
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  /** The live visualizer texture, or null when not (yet) engaged / unavailable. */
  get texture(): THREE.Texture | null {
    return this._texture;
  }

  /** True only when a texture exists and the layer is currently engaged. */
  get active(): boolean {
    return this.engaged && this._texture !== null;
  }

  /**
   * Attach the Web Audio context + a source node (the audio bed's master) for reactivity. Supplied
   * by the conductor once audio has started. Safe to call with null/undefined (stays silent).
   */
  attachAudio(context: unknown, node: unknown): void {
    this.audioContext = context ?? null;
    this.audioNode = node ?? null;
    if (this.viz && this.audioNode) this.tryConnectAudio();
    // If we were waiting on an audio context to initialize, kick it now.
    if (this.engaged && !this.viz && this.audioContext) void this.lazyInit();
  }

  /**
   * Engage or disengage the layer. The first engage (with an audio context attached) kicks off the
   * guarded async load; if it fails (no packages, no WebGL2, or any throw) the layer is marked
   * failed and stays a no-op.
   */
  engage(on: boolean): void {
    this.engaged = on;
    if (on && !this.viz && !this.loading && !this.failed && this.canvas && this.audioContext) {
      void this.lazyInit();
    }
  }

  /** Pick a preset (caller supplies a deterministic index from filterDirector). */
  selectPreset(index: number): void {
    if (!this.viz || index < 0 || index >= this.presets.length) return;
    try {
      this.viz.loadPreset(this.presets[index], 2.0);
    } catch {
      // a bad preset must not break the reel
    }
  }

  /** Render one visualizer frame and flag the texture dirty. Safe every frame; no-op if idle. */
  update(): void {
    if (!this.engaged || !this.viz || !this._texture) return;
    try {
      this.viz.render();
      this._texture.needsUpdate = true;
    } catch {
      this.failed = true;
    }
  }

  dispose(): void {
    this._texture?.dispose();
    this._texture = null;
    this.viz = null;
    this.presets = [];
  }

  private tryConnectAudio(): void {
    if (!this.viz || !this.audioNode) return;
    try {
      this.viz.connectAudio(this.audioNode);
    } catch {
      // reactivity is best-effort; the visual still animates without audio
    }
  }

  private async lazyInit(): Promise<void> {
    this.loading = true;
    try {
      if (!this.canvas) throw new Error('no canvas');
      if (!this.audioContext) throw new Error('no audio context');
      // Lazy + code-split: these chunks load only when the layer actually engages.
      const bcMod = await import('butterchurn');
      const factory = bcMod.default;
      const viz = factory.createVisualizer(this.audioContext, this.canvas, {
        width: this.width,
        height: this.height,
        pixelRatio: 1,
        textureRatio: 1,
      });

      // Presets (MIT package; see header + app/NOTICE for the provenance note).
      try {
        const pMod = await import('butterchurn-presets');
        const getPresets = pMod.default?.getPresets;
        if (typeof getPresets === 'function') {
          this.presets = Object.values(getPresets());
          if (this.presets.length > 0) viz.loadPreset(this.presets[0], 0);
        }
      } catch {
        // no preset pack → the visualizer still renders its default state; fine.
      }

      const tex = new THREE.CanvasTexture(this.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.userData.ownedByCompositor = false;
      viz.setRendererSize(this.width, this.height);

      this.viz = viz;
      this._texture = tex;
      this.tryConnectAudio();
    } catch {
      // Packages missing, no WebGL2, or any other failure: permanently degrade to a no-op.
      this.failed = true;
    } finally {
      this.loading = false;
    }
  }
}

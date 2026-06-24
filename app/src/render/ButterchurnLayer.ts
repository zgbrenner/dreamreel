// app/src/render/ButterchurnLayer.ts
//
// An optional psychedelic dream layer rendered by Butterchurn (a WebGL Milkdrop visualizer; the
// butterchurn library is MIT). It engages ONLY during high-intensity "frenzy" regimes (decided by
// dream/filterDirector.butterchurnEngaged) to give those moments an ever-changing, audio-reactive
// surreal wash, then disengages so the base reel resumes.
//
// ── Why it's optional + lazily loaded ──────────────────────────────────────────────────────────
// Butterchurn and its preset packs are NOT bundled by default:
//   • LICENSE: the `butterchurn` engine is MIT, but the community Milkdrop PRESETS shipped by
//     `butterchurn-presets` are of mixed/uncertain provenance. Per CLAUDE.md's hard license rules
//     (this is a commercial product), those presets must be vetted (prefer MIT/CC0 or hand-picked,
//     with rendered/recorded attribution) BEFORE anything is shipped. Until then we ship nothing.
//   • To enable: `npm i butterchurn butterchurn-presets`, vet the preset licensing, then run with
//     the `?butterchurn=1` flag. With the packages absent or the flag off, this module is a no-op.
// Everything here degrades gracefully: any failure (no packages, no WebGL2, perf/throw) leaves
// `texture` null and the base reel completely unaffected — it can NEVER break the dream.

import * as THREE from 'three';

// Minimal structural types for the (optionally present) butterchurn packages. We never import them
// statically — a runtime dynamic import keeps the build/bundle free of the dependency — so these
// describe just the surface we touch. Using `unknown`-narrowed casts avoids `any` in committed code.
interface BCVisualizer {
  loadPreset(preset: unknown, blendTime: number): void;
  setRendererSize(w: number, h: number): void;
  render(): void;
  connectAudio?(node: unknown): void;
}
interface BCFactory {
  createVisualizer(ctx: unknown, canvas: HTMLCanvasElement, opts: Record<string, unknown>): BCVisualizer;
}

export interface ButterchurnLayerOptions {
  width?: number;
  height?: number;
  /** Optional audio node (e.g. Tone.getContext().rawContext.destination analyser) for reactivity. */
  audioNode?: unknown;
  /** Optional audio context the visualizer should attach to. */
  audioContext?: unknown;
}

/**
 * A lazily-initialized Butterchurn visualizer wrapped as a THREE texture source. Construction is
 * cheap and synchronous; the heavy WebGL/library load happens on the first `engage(true)` and is
 * fully guarded. `texture` is null until (and unless) it successfully initializes.
 */
export class ButterchurnLayer {
  private readonly canvas: HTMLCanvasElement | null;
  private _texture: THREE.CanvasTexture | null = null;
  private viz: BCVisualizer | null = null;
  private presets: unknown[] = [];
  private engaged = false;
  private loading = false;
  private failed = false;
  private readonly width: number;
  private readonly height: number;
  private readonly opts: ButterchurnLayerOptions;

  constructor(opts: ButterchurnLayerOptions = {}) {
    this.opts = opts;
    this.width = opts.width ?? 512;
    this.height = opts.height ?? 288;
    // Guard for non-DOM (tests) — no canvas means this stays a permanent no-op.
    this.canvas =
      typeof document !== 'undefined' ? document.createElement('canvas') : null;
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
   * Engage or disengage the layer. The first engage kicks off the guarded async load; if it fails
   * (packages missing, no WebGL2, or any throw) the layer is marked failed and stays a no-op.
   */
  engage(on: boolean): void {
    this.engaged = on;
    if (on && !this.viz && !this.loading && !this.failed && this.canvas) {
      void this.lazyInit();
    }
  }

  /** Pick the next preset (caller supplies a deterministic index from filterDirector). */
  selectPreset(index: number): void {
    if (!this.viz || index < 0 || index >= this.presets.length) return;
    try {
      this.viz.loadPreset(this.presets[index], 2.0);
    } catch {
      // a bad preset must not break the reel
    }
  }

  /** Render one visualizer frame and flag the texture dirty. Safe to call every frame; no-op if idle. */
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

  private async lazyInit(): Promise<void> {
    this.loading = true;
    try {
      if (!this.canvas) throw new Error('no canvas');
      // Runtime-only dynamic import so the bundler never tries to resolve the optional packages.
      // The specifier is built at runtime + @vite-ignore'd; when the package is absent this rejects
      // and we degrade to a no-op.
      const bcSpec = 'butterchurn';
      const presetSpec = 'butterchurn-presets';
      const bcMod = (await import(/* @vite-ignore */ bcSpec)) as unknown as { default?: BCFactory } & BCFactory;
      const factory: BCFactory = (bcMod.default ?? bcMod) as BCFactory;

      const audioCtx = this.opts.audioContext ?? null;
      const viz = factory.createVisualizer(audioCtx, this.canvas, {
        width: this.width,
        height: this.height,
        pixelRatio: 1,
        textureRatio: 1,
      });
      if (this.opts.audioNode && typeof viz.connectAudio === 'function') {
        try {
          viz.connectAudio(this.opts.audioNode);
        } catch {
          // reactivity is best-effort; the visual still animates without audio
        }
      }

      // Presets are optional + license-gated (see header). Load whatever the pack exposes, if present.
      try {
        const pMod = (await import(/* @vite-ignore */ presetSpec)) as unknown as {
          default?: { getPresets?: () => Record<string, unknown> };
          getPresets?: () => Record<string, unknown>;
        };
        const getPresets = pMod.default?.getPresets ?? pMod.getPresets;
        if (typeof getPresets === 'function') {
          this.presets = Object.values(getPresets());
          if (this.presets.length > 0) viz.loadPreset(this.presets[0], 0);
        }
      } catch {
        // no preset pack → the visualizer still renders its default; fine.
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
    } catch {
      // Packages missing, no WebGL2, or any other failure: permanently degrade to a no-op.
      this.failed = true;
    } finally {
      this.loading = false;
    }
  }
}

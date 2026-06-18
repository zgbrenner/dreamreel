// app/src/render/Compositor.ts
import * as THREE from 'three';
import { TransitionMaterial } from './TransitionMaterial';
import { TRANSITION_NAMES } from './transitions';
import { loadImageTexture, type TextureLoadResult } from './textureLoader';

export type RenderFrame = (renderer: THREE.WebGLRenderer) => void;
export type FrameHook = (dtSec: number, elapsedSec: number) => void;

interface Crossfade {
  startMs: number;
  durationMs: number;
  to: THREE.Texture;
}

/**
 * Imperative three.js compositor. Owns the canvas, the WebGLRenderer, an orthographic
 * fullscreen scene, and the single requestAnimationFrame loop. Shows one asset, dissolves
 * to the next via a gl-transitions ShaderMaterial, and carries an independent ghost
 * (double-exposure) layer. Never leaves a black frame: callers substitute a procedural
 * texture when an image fails (see textureLoader + procedural sources).
 *
 * Post-FX (prompt 3) attaches by replacing `renderFrame`; the rAF loop stays singular.
 */
export class Compositor {
  renderer!: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /** Default frame renderer; post-FX overrides this with an EffectComposer.render. */
  renderFrame: RenderFrame;
  /** Notified on resize so post-FX can resize its composer/render targets. */
  onResize: ((w: number, h: number) => void) | null = null;

  private readonly frameListeners = new Set<FrameHook>();

  private readonly stageMaterial = new TransitionMaterial('fade');
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly ghostMesh: THREE.Mesh;

  private current: THREE.Texture | null = null;
  private crossfade: Crossfade | null = null;
  private rafId = 0;
  private running = false;
  private lastMs = 0;
  private startMs = 0;
  private width = 1;
  private height = 1;

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2);
    const stage = new THREE.Mesh(quad, this.stageMaterial);
    stage.frustumCulled = false;
    this.scene.add(stage);

    this.ghostMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ghostMesh = new THREE.Mesh(quad, this.ghostMaterial);
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.renderOrder = 1;
    this.ghostMesh.visible = false;
    this.scene.add(this.ghostMesh);

    this.renderFrame = (r) => r.render(this.scene, this.camera);
  }

  init(canvas: HTMLCanvasElement): void {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x0e0b08, 1);
    this.renderFrame = (r) => r.render(this.scene, this.camera);
    this.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1);
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.stageMaterial.setRatio(this.width / this.height);
    this.onResize?.(this.width, this.height);
  }

  /** Add a mesh to the stage scene (used by the dust/scratch system so it shares the pass). */
  addOverlay(mesh: THREE.Object3D): void {
    this.scene.add(mesh);
  }

  /** Detach an overlay mesh from the stage scene (mirror of addOverlay; used by LayerStack.dispose). */
  removeOverlay(mesh: THREE.Object3D): void {
    this.scene.remove(mesh);
  }

  /** Register a per-frame listener (procedural updates, post-FX animation, beat clocks). */
  addFrameListener(fn: FrameHook): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startMs = performance.now();
    this.lastMs = this.startMs;
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = (now - this.lastMs) / 1000;
      this.lastMs = now;
      this.advance(now);
      const elapsed = (now - this.startMs) / 1000;
      // Isolate each listener: a throw in one (e.g. a best-effort audio ramp) must never
      // stop the single rAF loop and freeze the whole dream. Log once per distinct message.
      for (const fn of this.frameListeners) {
        try {
          fn(dt, elapsed);
        } catch (err) {
          this.reportFrameError(err);
        }
      }
      this.renderFrame(this.renderer);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private lastFrameError = '';
  /** Surface a frame-listener exception once per distinct message (no per-frame spam). */
  private reportFrameError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === this.lastFrameError) return;
    this.lastFrameError = msg;
    console.error('[compositor] frame listener error (loop continues):', err);
  }

  /** Resolve an image URL to a texture, downscaled, with a fallback signal on failure. */
  async showImage(url: string, grade?: string): Promise<TextureLoadResult> {
    const res = await loadImageTexture(url);
    if (res.ok && grade) res.texture.userData.grade = grade;
    return res;
  }

  /**
   * Crossfade from the current texture to `to` over durationMs using `transitionName`.
   * The first ever call snaps in (no black frame). Passing a procedural texture is fine;
   * only compositor-owned textures get disposed on recycle.
   */
  crossfadeTo(to: THREE.Texture, transitionName: string, durationMs: number): void {
    if (!TRANSITION_NAMES.includes(transitionName)) transitionName = 'fade';
    this.stageMaterial.setTransition(transitionName);

    if (!this.current) {
      // First frame — snap in so we never show black.
      this.current = to;
      this.stageMaterial.setFrom(to);
      this.stageMaterial.setTo(to);
      this.stageMaterial.setProgress(0);
      return;
    }
    // If a crossfade is already mid-flight, settle it instantly before starting the next.
    if (this.crossfade) this.settleCrossfade(this.crossfade.to);
    this.stageMaterial.setFrom(this.current);
    this.stageMaterial.setTo(to);
    this.stageMaterial.setProgress(0);
    this.crossfade = { startMs: performance.now(), durationMs: Math.max(1, durationMs), to };
  }

  /** Set or clear the ghost (double-exposure) layer. */
  setGhost(tex: THREE.Texture | null, opacity: number): void {
    if (!tex || opacity <= 0) {
      this.ghostMesh.visible = false;
      this.ghostMaterial.opacity = 0;
      const prev = this.ghostMaterial.map;
      this.ghostMaterial.map = null;
      this.disposeIfOwned(prev, [this.current, this.crossfade?.to]);
      return;
    }
    if (this.ghostMaterial.map !== tex) {
      const prev = this.ghostMaterial.map;
      this.ghostMaterial.map = tex;
      this.ghostMaterial.needsUpdate = true;
      this.disposeIfOwned(prev, [this.current, this.crossfade?.to, tex]);
    }
    this.ghostMaterial.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
    this.ghostMesh.visible = true;
  }

  get currentTransition(): string {
    return this.stageMaterial.transitionName;
  }

  dispose(): void {
    this.stop();
    this.disposeIfOwned(this.current, []);
    this.disposeIfOwned(this.crossfade?.to, []);
    this.disposeIfOwned(this.ghostMaterial.map, []);
    this.stageMaterial.dispose();
    this.ghostMaterial.dispose();
    this.renderer.dispose();
  }

  private advance(now: number): void {
    const cf = this.crossfade;
    if (!cf) return;
    const p = (now - cf.startMs) / cf.durationMs;
    if (p >= 1) {
      this.settleCrossfade(cf.to);
    } else {
      this.stageMaterial.setProgress(p);
    }
  }

  private settleCrossfade(to: THREE.Texture): void {
    const old = this.current;
    this.current = to;
    this.stageMaterial.setFrom(to);
    this.stageMaterial.setTo(to);
    this.stageMaterial.setProgress(0);
    this.crossfade = null;
    // Recycle the texture we just faded away from, unless it's still referenced elsewhere.
    this.disposeIfOwned(old, [to, this.ghostMaterial.map]);
  }

  private disposeIfOwned(
    tex: THREE.Texture | null | undefined,
    keep: Array<THREE.Texture | null | undefined>,
  ): void {
    if (!tex) return;
    if (!tex.userData?.ownedByCompositor) return; // procedural textures are owned elsewhere
    if (keep.includes(tex)) return;
    tex.dispose();
  }
}

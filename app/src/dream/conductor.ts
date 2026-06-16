// app/src/dream/conductor.ts
// The integration layer: turns Dreamwalker beats into a playing dream. Three independent
// beat clocks (image / ghost / text) advance on the compositor's single rAF tick, staggered
// so the layers desync and recombine. Each image beat drives the audio mood, the film
// post-FX, and the on-screen caption. Implements DreamRuntime so the store can drive it.

import * as THREE from 'three';
import type { Manifest, Asset, MoodAxis, ProceduralKind } from '../manifest/types';
import { createDreamwalker, type Dreamwalker } from './dreamwalker';
import { makeRng, type Rng } from './prng';
import type { Compositor } from '../render/Compositor';
import type { PostFX } from '../render/postfx';
import { getProceduralTexture, type ProceduralSource } from '../render/procedural';
import { parseGrade } from '../render/filmParams';
import { attributionFor } from '../manifest/attribution';
import { TRANSITION_NAMES } from '../render/transitions';
import type { AudioEngine } from '../audio/engine';
import type { DreamRuntime } from '../state/runtime';
import type { Caption } from '../state/store';

export interface ConductorHooks {
  setCaption(c: Partial<Caption>): void;
  setMood(m: Record<MoodAxis, number>): void;
}

const IMAGE_FALLBACK_KINDS: ProceduralKind[] = ['fog', 'static', 'horizon', 'orbs'];

export class DreamConductor implements DreamRuntime {
  private readonly manifest: Manifest;
  private readonly compositor: Compositor;
  private readonly postfx: PostFX;
  private readonly audio: AudioEngine;
  private readonly hooks: ConductorHooks;

  private walker: Dreamwalker;
  private presRng: Rng;
  private seed: string;
  private surreality: number;
  private tempoMul: number;
  private archiveOn = true;

  private playing = false;
  private clock = 0; // internal seconds, advanced only while playing
  private nextImageAt = 0;
  private nextGhostAt = 0.7; // staggered starts -> desynced layers
  private nextTextAt = 1.3;
  private playedLeader = false;
  private unsub: (() => void) | null = null;

  private readonly procCache = new Map<string, ProceduralSource>();
  private readonly liveProcs = new Set<ProceduralSource>();
  private textCardTex: THREE.CanvasTexture | null = null;

  constructor(
    manifest: Manifest,
    compositor: Compositor,
    postfx: PostFX,
    audio: AudioEngine,
    hooks: ConductorHooks,
    init: { seed: string; surreality: number; tempoMul: number; archiveOn: boolean },
  ) {
    this.manifest = manifest;
    this.compositor = compositor;
    this.postfx = postfx;
    this.audio = audio;
    this.hooks = hooks;
    this.seed = init.seed;
    this.surreality = init.surreality;
    this.tempoMul = init.tempoMul;
    this.archiveOn = init.archiveOn;
    this.presRng = makeRng(`${this.seed}:pres`);
    this.walker = this.buildWalker();
    this.unsub = compositor.addFrameListener((dt) => this.tick(dt));
  }

  // --- DreamRuntime ---

  async play(): Promise<void> {
    this.playing = true;
    this.compositor.start();
    try {
      await this.audio.start();
      this.audio.setVolume(true);
      this.audio.setTempo(this.tempoMul);
    } catch {
      // audio is best-effort; the dream plays regardless
    }
  }

  pause(): void {
    this.playing = false;
    this.audio.suspend();
  }

  setSurreality(v: number): void {
    this.surreality = v;
    this.walker.setSurreality(v);
  }

  setTempo(v: number): void {
    this.tempoMul = v;
    this.audio.setTempo(v);
  }

  setSound(on: boolean): void {
    this.audio.setVolume(on);
  }

  setArchive(on: boolean): void {
    if (on === this.archiveOn) return;
    this.archiveOn = on;
    this.walker = this.buildWalker();
    this.hardCut();
  }

  reseed(seed: string, surreality: number, tempoMul: number): void {
    this.seed = seed;
    this.surreality = surreality;
    this.tempoMul = tempoMul;
    this.presRng = makeRng(`${seed}:pres`);
    this.walker = this.buildWalker();
    this.audio.setTempo(tempoMul);
    this.hardCut();
  }

  dispose(): void {
    this.unsub?.();
    for (const p of this.procCache.values()) p.dispose();
    this.procCache.clear();
    this.textCardTex?.dispose();
  }

  // --- internals ---

  private buildWalker(): Dreamwalker {
    const visual = this.manifest.assets.filter((a) =>
      this.archiveOn ? true : a.type === 'procedural' || a.type === 'titlecard',
    );
    const pool = visual.length > 0 ? visual : this.manifest.assets.filter((a) => a.type === 'procedural');
    return createDreamwalker(
      { visual: pool, texts: this.manifest.texts, moodAxes: this.manifest.moodAxes, embeddingDim: this.manifest.embeddingDim },
      { seed: this.seed, surreality: this.surreality },
    );
  }

  /** Reschedule all clocks to fire promptly — a hard cut into a new seed/pool. */
  private hardCut(): void {
    this.nextImageAt = this.clock;
    this.nextGhostAt = this.clock + 0.5;
    this.nextTextAt = this.clock + 0.2;
    this.postfx.triggerSplice(1);
    this.playedLeader = true; // skip the academy leader on reseeds; only the first play shows it
  }

  private tick(dt: number): void {
    if (!this.playing) return;
    this.clock += dt;
    // keep any live procedural sources animating on the internal clock
    for (const p of this.liveProcs) p.update(this.clock);

    if (this.clock >= this.nextImageAt) this.imageBeat();
    if (this.clock >= this.nextGhostAt) this.ghostBeat();
    if (this.clock >= this.nextTextAt) this.textBeat();
  }

  private imageBeat(): void {
    // First ever play opens on the academy leader.
    if (!this.playedLeader) {
      this.playedLeader = true;
      const leader = this.proc('__leader__', 'leader');
      this.markLive(leader);
      this.compositor.crossfadeTo(leader.texture, 'fade', 600);
      this.hooks.setCaption({ reel: 'ACADEMY LEADER', source: 'DREAMREEL / procedural', whisper: '', license: 'CC0', attribution: undefined, attributionUrl: undefined });
      this.nextImageAt = this.clock + 3.2;
      return;
    }

    const beat = this.walker.next('image', this.tempoMul);
    const mood = this.walker.currentMood();
    this.hooks.setMood(mood);
    this.audio.setMood(mood);
    this.applyMoodToFilm(mood, beat.asset);

    const transition = TRANSITION_NAMES[this.presRng.int(TRANSITION_NAMES.length)];

    if (beat.titleCard) {
      // Cut to a black Bodoni intertitle instead of an image.
      const tex = this.makeTitleCard(beat.asset.text ?? '');
      this.compositor.crossfadeTo(tex, 'fade', 280);
      this.postfx.triggerSplice(0.7);
      this.hooks.setCaption({
        reel: 'INTERTITLE',
        source: beat.asset.source,
        whisper: beat.asset.text ?? '',
        license: beat.asset.license,
        attribution: ccByAttribution(beat.asset),
        attributionUrl: beat.asset.attributionUrl,
      });
    } else {
      this.resolveVisual(beat.asset, transition);
      this.hooks.setCaption({
        reel: reelLabel(beat.asset),
        source: beat.asset.source,
        license: beat.asset.license,
        attribution: ccByAttribution(beat.asset),
        attributionUrl: beat.asset.attributionUrl,
      });
    }

    this.nextImageAt = this.clock + beat.dwellMs / 1000;
  }

  private ghostBeat(): void {
    const mood = this.walker.currentMood();
    const intensity = Math.max(mood.uncanny, mood.ominous);
    const beat = this.walker.next('ghost', this.tempoMul);
    if (intensity > 0.58) {
      const tex = this.textureForAsset(beat.asset);
      if (tex) this.compositor.setGhost(tex, 0.18 + intensity * 0.32);
    } else {
      this.compositor.setGhost(null, 0);
    }
    this.nextGhostAt = this.clock + beat.dwellMs / 1000;
  }

  private textBeat(): void {
    const beat = this.walker.next('text', this.tempoMul);
    this.hooks.setCaption({ whisper: beat.asset.text ?? '' });
    this.nextTextAt = this.clock + beat.dwellMs / 1000;
  }

  /** Resolve an image/procedural asset to a texture and crossfade; never leave black. */
  private resolveVisual(asset: Asset, transition: string): void {
    if (asset.type === 'procedural') {
      const src = this.proc(asset.id, asset.kind ?? 'fog');
      this.markLive(src);
      this.compositor.crossfadeTo(src.texture, transition, this.crossfadeMs());
      return;
    }
    if (asset.type === 'image' && asset.src) {
      void this.compositor.showImage(asset.src, asset.grade).then((res) => {
        if (res.ok) {
          this.compositor.crossfadeTo(res.texture, transition, this.crossfadeMs());
        } else {
          // fall back to a deterministic procedural so the reel never breaks
          const kind = IMAGE_FALLBACK_KINDS[this.presRng.int(IMAGE_FALLBACK_KINDS.length)];
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          this.compositor.crossfadeTo(src.texture, transition, this.crossfadeMs());
        }
      });
      return;
    }
    // titlecard-type asset used as a visual, or anything else -> text card
    const tex = this.makeTitleCard(asset.text ?? '');
    this.compositor.crossfadeTo(tex, transition, this.crossfadeMs());
  }

  private textureForAsset(asset: Asset): THREE.Texture | null {
    if (asset.type === 'procedural') {
      const src = this.proc(asset.id, asset.kind ?? 'fog');
      this.markLive(src);
      return src.texture;
    }
    // For ghosting we prefer cheap procedural echoes; image ghosts would need a second load.
    const src = this.proc(`ghost:${asset.id}`, IMAGE_FALLBACK_KINDS[asset.id.length % IMAGE_FALLBACK_KINDS.length]);
    this.markLive(src);
    return src.texture;
  }

  private applyMoodToFilm(mood: Record<MoodAxis, number>, asset: Asset): void {
    // Surreality opens up the dreamier, less photographic treatments (bloom, haze, leaks,
    // colour drift, fringing) so a high-surreality reel reads as a proper dream, not a film.
    const s = this.surreality;
    this.postfx.setParams({
      vignette: 0.42 + mood.ominous * 0.32,
      grain: 0.16 + (1 - mood.tender) * 0.16 + mood.mechanical * 0.06,
      sepia: 0.36 + mood.nostalgic * 0.22,
      desat: 0.28 + mood.melancholy * 0.22,
      halation: 0.25 + mood.tender * 0.32,
      scanline: 0.08 + mood.mechanical * 0.16,
      bloom: 0.3 + mood.tender * 0.5 + s * 0.4,
      haze: 0.14 + mood.melancholy * 0.24 + mood.nostalgic * 0.16 + s * 0.18,
      lightLeak: 0.18 + mood.nostalgic * 0.3 + s * 0.3,
      tint: 0.18 + mood.uncanny * 0.3 + s * 0.2,
      chroma: 0.15 + mood.uncanny * 0.5 + s * 0.35,
      exposure: 1 + mood.tender * 0.06,
      breathe: 0.4 + s * 0.5,
    });
    this.postfx.setGradeSepia(parseGrade(asset.grade));

    // Punctuate the cut with an occasional one-shot dream swell; more likely as surreality
    // rises. Uncanny moods lean toward colour-fringe surges, tender ones toward soft blooms.
    if (this.presRng.next() < 0.18 + s * 0.4) {
      const roll = this.presRng.next();
      const target =
        roll < 0.25 + mood.uncanny * 0.3
          ? 'chroma'
          : roll < 0.5
            ? 'bleach'
            : roll < 0.75
              ? 'bloom'
              : roll < 0.9
                ? 'leak'
                : 'tint';
      this.postfx.triggerDreamSurge(target, 0.5 + this.presRng.next() * 0.6);
    }
  }

  private crossfadeMs(): number {
    const base = this.postfx.params.reduceMotion ? 2000 : 1100;
    return base / Math.max(0.5, this.tempoMul);
  }

  private proc(key: string, kind: ProceduralKind): ProceduralSource {
    let src = this.procCache.get(key);
    if (!src) {
      src = getProceduralTexture(kind, `${this.seed}:${key}`);
      this.procCache.set(key, src);
    }
    return src;
  }

  private markLive(src: ProceduralSource): void {
    // keep a small set of recently-shown procedural sources updating; cap to avoid growth
    this.liveProcs.add(src);
    if (this.liveProcs.size > 6) {
      const first = this.liveProcs.values().next().value as ProceduralSource | undefined;
      if (first && first !== src) this.liveProcs.delete(first);
    }
  }

  private makeTitleCard(text: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 576;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0E0B08';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#D8D2C4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const words = text.toUpperCase().split(/\s+/);
    const lines = wrapWords(words, 22);
    const fontSize = lines.length > 2 ? 54 : 68;
    ctx.font = `600 ${fontSize}px "Bodoni Moda", serif`;
    const lh = fontSize * 1.5;
    const startY = canvas.height / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      ctx.fillText(spaced(line), canvas.width / 2, startY + i * lh);
    });
    // double-line frame
    ctx.strokeStyle = '#6B5640';
    ctx.lineWidth = 2;
    ctx.strokeRect(60, 60, canvas.width - 120, canvas.height - 120);

    this.textCardTex?.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.ownedByCompositor = false;
    this.textCardTex = tex;
    return tex;
  }
}

// --- helpers ---

function reelLabel(asset: Asset): string {
  const tag = asset.tags[0] ? asset.tags[0].toUpperCase() : asset.type.toUpperCase();
  return `REEL — ${tag}`;
}

function ccByAttribution(asset: Asset): string | undefined {
  return attributionFor(asset);
}

function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur.trim());
  return lines.slice(0, 4);
}

function spaced(s: string): string {
  return s.split('').join(' '); // hair-space tracking for the intertitle look
}

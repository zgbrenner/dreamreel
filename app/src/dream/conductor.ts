// app/src/dream/conductor.ts
// The integration layer: turns Dreamwalker beats into a playing dream. Three independent
// beat clocks (image / ghost / text) advance on the compositor's single rAF tick, staggered
// so the layers desync and recombine. Each image beat drives the audio mood, the film
// post-FX, and the on-screen caption. Implements DreamRuntime so the store can drive it.

import * as THREE from 'three';
import type { Manifest, Asset, MoodAxis, ProceduralKind } from '../manifest/types';
import { titleCardPalette } from './textDirector';
import { blankMood } from './mood';
import { createDreamwalker, type Dreamwalker } from './dreamwalker';
import { DreamMemory } from './memory';
import { makeRng, type Rng } from './prng';
import { createIntensityEngine, type IntensityEngine, type IntensityRegime } from './intensity';
import {
  createSteeringController,
  shimmerFromSteering,
  type SteeringController,
  type SteeringState,
} from './steering';
import { coherenceForTrough } from './coherence';
import {
  filterStrengths,
  moshStrength,
  swapFadeRate,
  preferSlow,
  preferColor,
  capDistortion,
  pickTransition,
  proceduralParams,
  butterchurnEngaged,
  butterchurnPresetIndex,
  type FilterStrengths,
} from './filterDirector';
import { pickSwapSlot } from './slotHold';
import { planLayers, MAX_LAYERS, type LayerPlan } from './layerPlan';
import { LayerStack } from '../render/LayerStack';
import { ButterchurnLayer } from '../render/ButterchurnLayer';
import type { Compositor } from '../render/Compositor';
import type { PostFX } from '../render/postfx';
import { getProceduralTexture, type ProceduralSource } from '../render/procedural';
import type { Shot } from '../render/VideoPool';
import { SpriteField, makeSpritePlacement } from '../render/SpriteField';
import { loadImageTexture } from '../render/textureLoader';
import type { EntitySprite } from '../manifest/types';
import { visualPool, flashFramePool } from './visualPool';
import { deriveMoodIdentity } from './moodBias';
import { parseGrade, type FilmParams } from '../render/filmParams';
import { attributionFor } from '../manifest/attribution';
import type { AudioEngine } from '../audio/engine';
import { createAudioWalker, type AudioWalker } from './audioWalker';
import { createMixer, type Mixer } from '../audio/mixer';
import { makeAudioCadence, onVisualBeat, commitPick, type AudioCadence } from './audioCadence';
import type { DreamRuntime } from '../state/runtime';
import type { Caption } from '../state/store';

export interface ConductorHooks {
  setCaption(c: Partial<Caption>): void;
  setMood(m: Record<MoodAxis, number>): void;
}

const IMAGE_FALLBACK_KINDS: ProceduralKind[] = ['fog', 'static', 'horizon', 'orbs'];

/**
 * Deterministic procedural fallback kind for a failed asset load. Pure hash of the asset id —
 * NEVER a draw from the shared presRng: fallback picks happen inside async load callbacks, and
 * drawing a shared stream there would interleave with the synchronous per-swap draws in a
 * network-timing-dependent order, breaking the same-seed-same-dream contract.
 */
function fallbackKindFor(assetId: string): ProceduralKind {
  let h = 0;
  for (let i = 0; i < assetId.length; i++) h = (h * 31 + assetId.charCodeAt(i)) | 0;
  return IMAGE_FALLBACK_KINDS[Math.abs(h) % IMAGE_FALLBACK_KINDS.length];
}

// Literal entity-recurrence (sprite) summoning. A cutout is summoned only when its entity is
// strongly remembered, at a bounded rate, so the effect is a rare, dreamlike return — not a parade.
const SPRITE_SUMMON_PROB = 0.03; // per primary beat, once an eligible motif exists
const SPRITE_MIN_WEIGHT = 2.2; // memory weight an entity must reach to be "strongly remembered"
const SPRITE_COOLDOWN_S = 20; // minimum seconds between summons

// Rare flash-frame / ghost-layer texture for DEMOTED stills (video-first direction): an `image`
// asset never holds a primary beat — it surfaces only here, as a quick subliminal double-exposure.
// Bounded by probability + cooldown so it stays a dreamlike echo, not a slideshow.
const FLASH_FRAME_PROB = 0.035; // per ghost beat (classic) / per swap beat (wake)
const FLASH_FRAME_COOLDOWN_S = 18; // minimum seconds between flash-frames

// "Dream turns to colour" (the Wizard-of-Oz moment). Rare + long-cooled so it stays an event, not
// a mode; only fires on gentle low-intensity beats over a clip that carries a colorized variant.
const COLOR_TURN_PROB = 0.25; // per eligible gentle beat (already narrowed by preferColor)
const COLOR_TURN_COOLDOWN_S = 75; // minimum seconds between colour turns
const COLOR_HOLD_S = 8; // duration of the bloom (a sine ease in and back out)
const WAKE_FLASH_HOLD_S = 0.9; // how long a wake-mode flash-frame stays on the overlay

// Hypnagogic onset (sleep-onset research: imagery begins as fragmentary flashes before cohering
// into scenes). For the first few seconds of a wake dream, swaps run fast and the hero layer is
// held translucent, easing to full presence as the dream "falls asleep". Clock-driven and
// presentation-only — the seeded asset sequence is untouched (timing may vary by contract).
const ONSET_S = 7;

export class DreamConductor implements DreamRuntime {
  private readonly manifest: Manifest;
  private readonly compositor: Compositor;
  private readonly postfx: PostFX;
  private readonly audio: AudioEngine;
  private readonly hooks: ConductorHooks;

  private walker: Dreamwalker;
  private presRng: Rng;
  // Dedicated deterministic stream for picking which baked shot a video plays — isolated from
  // presRng so it never perturbs other presentation draws. Drawn only on video shows (a beat in
  // the deterministic sequence), so the shot sequence is reproducible per seed.
  private shotRng: Rng;

  // Literal entity recurrence: when the dream strongly remembers an entity, summon its segmented
  // cutout as a drifting ghost (render/SpriteField). Deterministic via a dedicated seeded stream.
  private spriteRng!: Rng;
  private readonly spriteField = new SpriteField();
  private readonly spritePool = new Map<string, EntitySprite[]>();
  private readonly spriteTex = new Map<string, import('three').Texture>();
  private readonly spriteLoading = new Set<string>();
  private spriteCooldownUntil = 0;

  // Demoted stills routed to the rare flash-frame / ghost-layer path (video-first). The pool is the
  // `image` assets visualPool excluded from primary; a dedicated seeded stream + cooldown keep the
  // flashes reproducible per seed and rare. Loaded image textures are cached and disposed on dispose.
  private flashRng!: Rng;
  private flashPool: Asset[] = [];
  private readonly flashTex = new Map<string, THREE.Texture>();
  private readonly flashLoading = new Set<string>();
  // Baked depth maps (Asset.depthSrc) and flow textures (Asset.flowSrc), cached per asset id.
  // Conductor-owned: disposed in dispose(), never by the materials they're bound to.
  private readonly depthTex = new Map<string, THREE.Texture>();
  private readonly depthLoading = new Set<string>();
  private readonly flowTex = new Map<string, THREE.Texture>();
  private readonly flowLoading = new Set<string>();
  private flashCooldownUntil = 0;
  // "Dream turns to colour" — a rare seeded moment where a gentle beat's colorized clip
  // (Asset.colorSrc) blooms into colour, then relaxes back. A dedicated stream + cooldown keep it
  // reproducible per seed and special; colorHoldUntil is the clock end of the current bloom.
  private colorRng!: Rng;
  private colorCooldownUntil = 0;
  private colorHoldUntil = 0;
  private seed: string;
  private surreality: number;
  private tempoMul: number;
  private archiveOn = true;

  // --- wake mode (intensity-driven chaos scheduler) ---
  private readonly wake: boolean;
  private intensity: IntensityEngine;
  private layerStack: LayerStack | null;
  // Optional psychedelic Butterchurn layer (flag-gated, wake-only, frenzy-only). Null unless
  // ?butterchurn=1; degrades to a no-op if the optional packages/WebGL aren't available.
  private butterchurn: ButterchurnLayer | null = null;
  private bcPresetTrough = -1; // last trough id we re-rolled a preset on
  // Latest mood + intensity, so procedural sources can be styled via filterDirector.proceduralParams.
  private lastMood: Record<MoodAxis, number> | null = null;
  private lastIntensity = 0.5;
  private layerCursor = 0;
  private slotHeldUntil: number[] = new Array(MAX_LAYERS).fill(0);
  private activeTrough = -1;
  // Trough id currently playing as a FALSE AWAKENING (treatment drops to near-zero), or -1.
  private awakeTroughId = -1;
  // Hypnagogic-onset window end (wake mode); the first dream opens at clock 0, so the window
  // starts armed. Re-armed on reseed; inert once the clock passes it.
  private onsetUntil = ONSET_S;
  // When a wake-mode flash-frame is on the overlay, the clock time it should clear at (0 = none).
  private wakeGhostUntil = 0;
  private nextSwapAt = 0;
  private lastWakeMood: Record<MoodAxis, number> | null = null;
  // The discrete layer "recipe" (count + per-layer blends + feedback/warp). Recomputed only
  // when a swap fires, then held steady between swaps so density/blends don't strobe per frame.
  private currentPlan: LayerPlan | null = null;

  // --- audio walker + mixer (sampled audio layer) ---
  private readonly audioWalker: AudioWalker | null;
  private mixer: Mixer | null = null;
  private soundOn = true;
  private audioCadence: AudioCadence = makeAudioCadence();

  // --- ambient behavioral steering ---
  // A live, native-API steering source (NO webcam). Each tick its normalized SteeringState is split
  // two ways: CONTENT fields bend the seeded walk (walker.setSteering) and ease the wake intensity on
  // blur; PRESENTATION fields drive the compositor shimmer. The bend is bounded and relaxes back to
  // the seeded spine when input fades, so a passive viewer gets the exact seeded dream.
  private readonly steering: SteeringController;
  private readonly baseMaxIntensity: number;

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
    init: {
      seed: string;
      surreality: number;
      tempoMul: number;
      archiveOn: boolean;
      wake?: boolean;
      butterchurn?: boolean;
    },
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
    this.shotRng = makeRng(`${this.seed}:shots`);
    this.spriteRng = makeRng(`${this.seed}:sprites`);
    this.flashRng = makeRng(`${this.seed}:flash`);
    this.colorRng = makeRng(`${this.seed}:color`);
    // Index the entity cutout pool by entity for memory-triggered summoning, and overlay the field.
    for (const sp of manifest.entitySprites ?? []) {
      const list = this.spritePool.get(sp.entity);
      if (list) list.push(sp);
      else this.spritePool.set(sp.entity, [sp]);
    }
    this.compositor.addOverlay(this.spriteField.group);
    this.walker = this.buildWalker();
    this.wake = init.wake ?? false;
    this.intensity = createIntensityEngine(this.seed);
    this.layerStack = this.wake ? new LayerStack(compositor) : null;
    // Butterchurn engages only in wake mode and only when explicitly opted in. Its heavy WebGL load
    // is deferred to first engage; everything degrades gracefully so the base reel is never at risk.
    this.butterchurn = this.wake && init.butterchurn ? new ButterchurnLayer() : null;
    this.baseMaxIntensity = this.postfx.params.reduceMotion ? 0.45 : 1;
    this.intensity.setMaxIntensity(this.baseMaxIntensity);
    this.steering = createSteeringController({ reduceMotion: this.postfx.params.reduceMotion });
    // AudioWalker is pure (no DOM/Tone); build it eagerly so its seeded state is ready.
    // The Mixer is built lazily inside play() because it needs engine.masterGain, which
    // only exists after audio.start() has returned.
    this.audioWalker = manifest.audio.length
      ? createAudioWalker(
          { audio: manifest.audio, audioEmbeddingDim: manifest.audioEmbeddingDim },
          { seed: this.seed, surreality: this.surreality },
        )
      : null;
    this.unsub = compositor.addFrameListener((dt) => this.tick(dt));
  }

  // --- DreamRuntime ---

  async play(): Promise<void> {
    this.playing = true;
    this.compositor.start();
    this.compositor.resumeVideos();
    try {
      // Per-seed sonic identity: derive the synth character before the graph is built so this
      // dream's bed is its own instrument (mood still plays it via setMood). Best-effort.
      this.safeAudio(() => this.audio.setSeed(this.seed));
      await this.audio.start();
      this.audio.setVolume(this.soundOn);
      this.audio.setTempo(this.tempoMul);
      // Build the Mixer lazily here — after start() — because engine.masterGain is only
      // available once the Tone graph has been constructed inside audio.start().
      if (this.audioWalker && !this.mixer) {
        const master = this.audio.masterGain;
        if (master) {
          this.safeAudio(() => {
            this.mixer = createMixer({ master: master });
            this.mixer!.setEnabled(this.soundOn);
            this.mixer!.resume();
          });
        }
      }
      // Give the (optional) Butterchurn layer a Web Audio tap for reactivity — best-effort.
      if (this.butterchurn) {
        this.safeAudio(() => {
          const tap = this.audio.getVisualizerTap();
          this.butterchurn?.attachAudio(tap?.context, tap?.node);
        });
      }
    } catch {
      // audio is best-effort; the dream plays regardless
    }
  }

  pause(): void {
    this.playing = false;
    this.compositor.pauseVideos();
    this.safeAudio(() => this.audio.suspend());
    this.safeAudio(() => this.mixer?.pause());
  }

  /** Audio is best-effort: a failing audio call must never break the dream (see CLAUDE.md). */
  private safeAudio(fn: () => void): void {
    try {
      fn();
    } catch {
      // swallow — the visual dream plays regardless of the audio bed
    }
  }

  setSurreality(v: number): void {
    this.surreality = v;
    this.walker.setSurreality(v);
  }

  setTempo(v: number): void {
    this.tempoMul = v;
    this.safeAudio(() => this.audio.setTempo(v));
  }

  setSound(on: boolean): void {
    this.soundOn = on;
    this.safeAudio(() => this.audio.setVolume(on));
    this.safeAudio(() => this.mixer?.setEnabled(on));
  }

  setArchive(on: boolean): void {
    if (on === this.archiveOn) return;
    this.archiveOn = on;
    this.walker = this.buildWalker();
    this.hardCut();
    this.safeAudio(() => this.mixer?.setArchiveAudio(on));
  }

  reseed(seed: string, surreality: number, tempoMul: number): void {
    this.seed = seed;
    this.surreality = surreality;
    this.tempoMul = tempoMul;
    this.presRng = makeRng(`${seed}:pres`);
    this.shotRng = makeRng(`${seed}:shots`);
    this.spriteRng = makeRng(`${seed}:sprites`);
    this.flashRng = makeRng(`${seed}:flash`);
    this.flashCooldownUntil = 0;
    this.colorRng = makeRng(`${seed}:color`);
    this.colorCooldownUntil = 0;
    this.colorHoldUntil = 0;
    this.spriteField.dispose();
    this.spriteCooldownUntil = 0;
    this.walker = this.buildWalker();
    this.intensity.reseed(seed);
    this.activeTrough = -1;
    this.awakeTroughId = -1;
    this.onsetUntil = this.clock + ONSET_S; // a new dream falls asleep again
    this.wakeGhostUntil = 0;
    this.compositor.setWakeGhost(null, 0);
    this.layerCursor = 0;
    this.slotHeldUntil.fill(0);
    this.currentPlan = null;
    this.lastWakeMood = null;
    this.lastMood = null;
    this.lastIntensity = 0.5;
    this.bcPresetTrough = -1;
    this.butterchurn?.engage(false);
    this.layerStack?.setPsychedelic(null, 0);
    this.safeAudio(() => this.audio.setTempo(tempoMul));
    this.safeAudio(() => this.audio.setSeed(seed)); // "New dream" re-tunes the bed to the new voice
    // Reset audio walk accumulators so the new seed starts a fresh audio sequence.
    this.audioWalker?.reseed(seed);
    this.audioCadence = makeAudioCadence();
    this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
    this.hardCut();
  }

  dispose(): void {
    this.unsub?.();
    this.steering.dispose();
    this.butterchurn?.dispose();
    this.layerStack?.dispose();
    this.spriteField.dispose();
    for (const t of this.spriteTex.values()) t.dispose();
    this.spriteTex.clear();
    for (const t of this.flashTex.values()) t.dispose();
    this.flashTex.clear();
    for (const t of this.depthTex.values()) t.dispose();
    this.depthTex.clear();
    for (const t of this.flowTex.values()) t.dispose();
    this.flowTex.clear();
    for (const p of this.procCache.values()) p.dispose();
    this.procCache.clear();
    this.textCardTex?.dispose();
    this.safeAudio(() => this.mixer?.dispose());
  }

  // --- internals ---

  // The dream's recurrence memory: a fresh dream starts with no memory; each logical visual beat
  // folds the shown asset's entities in (and decays the rest), so motifs recur deterministically.
  private readonly memory = new DreamMemory();

  private buildWalker(): Dreamwalker {
    const pool = visualPool(this.manifest.assets, this.archiveOn);
    // Stills demoted out of the primary pool feed the rare flash-frame / ghost path instead.
    this.flashPool = flashFramePool(this.manifest.assets, this.archiveOn);
    const walker = createDreamwalker(
      { visual: pool, texts: this.manifest.texts, moodAxes: this.manifest.moodAxes, embeddingDim: this.manifest.embeddingDim },
      // The seed's emotional identity (gentle-leaning, fear a minority) biases the walk's start +
      // picks so each dream has a coherent mood instead of wandering uniformly. Deterministic per seed.
      { seed: this.seed, surreality: this.surreality, moodIdentity: deriveMoodIdentity(this.seed) },
    );
    // A new walk = a fresh memory; the walk leans toward candidates echoing what it remembers.
    this.memory.reset();
    walker.setRecurrence((e) => this.memory.echo(e));
    return walker;
  }

  /** Fold the just-shown primary asset into the dream's memory (decay first, then observe) so the
   *  NEXT pick is biased toward recurring motifs. Deterministic — driven by the seeded beat sequence. */
  private observeMemory(asset: Asset): void {
    this.memory.decayStep();
    this.memory.observe(asset.entities);
  }

  /** When the dream strongly remembers an entity that has a cutout, occasionally summon it as a
   *  drifting ghost — the literal fragment returns. Deterministic (seeded), bounded, reduced-motion
   *  off. Drawn on primary beats, so the summon sequence is reproducible per seed. */
  private maybeSummonSprite(): void {
    if (this.spritePool.size === 0 || this.postfx.params.reduceMotion) return;
    if (this.clock < this.spriteCooldownUntil) return;
    if (this.spriteRng.next() > SPRITE_SUMMON_PROB) return;

    // Pick the most strongly-remembered entity that has a cutout (deterministic; name tie-break).
    let bestEntity: string | undefined;
    let bestWeight = SPRITE_MIN_WEIGHT;
    for (const entity of this.spritePool.keys()) {
      const w = this.memory.weightOf(entity);
      if (w > bestWeight || (w === bestWeight && bestEntity !== undefined && entity < bestEntity)) {
        bestWeight = w;
        bestEntity = entity;
      }
    }
    if (bestEntity === undefined) return;

    const candidates = this.spritePool.get(bestEntity)!.filter((sp) => (sp.frames ?? 1) > 1);
    if (candidates.length === 0) return;
    const sprite = candidates[this.spriteRng.int(candidates.length)];
    const placement = makeSpritePlacement(this.spriteRng);
    this.spriteCooldownUntil = this.clock + SPRITE_COOLDOWN_S;
    // Animated (SAM 2 video-tracked) cutouts carry a sprite sheet; static ones don't.
    const anim =
      sprite.frames && sprite.frames > 1
        ? { frames: sprite.frames, cols: sprite.cols ?? 1, fps: sprite.fps ?? 10 }
        : undefined;

    const cached = this.spriteTex.get(sprite.id);
    if (cached) {
      this.spriteField.summon(cached, sprite.aspect, placement, this.clock, anim);
      return;
    }
    if (this.spriteLoading.has(sprite.id)) return;
    this.spriteLoading.add(sprite.id);
    void loadImageTexture(sprite.src).then((res) => {
      this.spriteLoading.delete(sprite.id);
      if (res.ok) {
        this.spriteTex.set(sprite.id, res.texture);
        this.spriteField.summon(res.texture, sprite.aspect, placement, this.clock, anim);
      }
    });
  }

  /** Reschedule all clocks to fire promptly — a hard cut into a new seed/pool. */
  private hardCut(): void {
    this.nextImageAt = this.clock;
    this.nextGhostAt = this.clock + 0.5;
    this.nextTextAt = this.clock + 0.2;
    this.nextSwapAt = this.clock; // wake mode: swap a fresh layer promptly on a hard cut
    this.currentPlan = null; // force a fresh recipe to be rolled on the prompt swap
    this.postfx.triggerSplice(1);
    this.playedLeader = true; // skip the academy leader on reseeds; only the first play shows it
  }

  private tick(dt: number): void {
    // Read ambient steering every frame (even while paused, so the held gate frame still parallaxes).
    // CONTENT split goes to the walk; PRESENTATION split goes to the camera shimmer — kept separate
    // so the shimmer can never alter which assets/text/events occur.
    const steer = this.steering.state;
    this.walker.setSteering(steer);
    this.applySteeringToFilm(steer);
    const sh = shimmerFromSteering(steer);
    this.compositor.setShimmer(sh.dx, sh.dy, sh.zoom);
    // 2.5D depth-parallax drive (presentation-only, like the shimmer): pointer/tilt attention
    // leans the depth-bound layers, and a slow clock drift keeps even a passive dream breathing
    // dimensionally. Only assets with a baked depth map respond; everything else stays flat.
    const px = (sh.dx * 1.6 + Math.sin(this.clock * 0.13) * 0.35) * 0.05;
    const py = (sh.dy * 1.6 + Math.cos(this.clock * 0.11) * 0.3) * 0.05;
    this.layerStack?.setParallax(px, py);
    this.compositor.setGhostParallax(px, py);

    if (!this.playing) return;
    this.clock += dt;
    // keep any live procedural sources animating on the internal clock
    for (const p of this.liveProcs) p.update(this.clock);
    // drift + fade any summoned entity cutouts
    this.spriteField.update(dt, this.clock);

    if (this.wake) {
      this.wakeTick(dt);
      return;
    }

    if (this.clock >= this.nextImageAt) this.imageBeat();
    if (this.clock >= this.nextGhostAt) this.ghostBeat();
    if (this.clock >= this.nextTextAt) this.textBeat();
  }

  /**
   * Content bend from focus: when the document is BLURRED (the viewer looks away), ease the wake
   * intensity ceiling down so the reel drifts calmer and is more likely to settle into a coherence
   * trough — then relax back to the seed's baseline ceiling when focus returns. Bounded, and a no-op
   * for a focused (passive-attentive) viewer, so the seeded dream is preserved. Classic mode (no
   * intensity engine driving the reel) is unaffected beyond the harmless setMaxIntensity bookkeeping.
   */
  private applySteeringToFilm(steer: SteeringState): void {
    const blur = 1 - steer.focus; // 0 focused, 1 fully blurred
    const ceiling = this.baseMaxIntensity * (1 - 0.55 * blur);
    this.intensity.setMaxIntensity(ceiling);
  }

  // --- wake mode ---

  /**
   * The intensity-driven scheduler. Each tick samples a seeded IntensityEngine on the logical
   * (tempo-scaled) clock and drives the CONTINUOUS look — intensity-scaled warp/grade/chroma/
   * bloom on the post-FX — plus coherence behaviour at troughs (rhyme tightens the walker;
   * phrase surfaces a legible line). The DISCRETE recipe (layer count + per-layer blends via
   * planLayers) is recomputed only when a swap fires (see swapWakeLayer) and held steady between
   * swaps, so density/blends don't strobe per frame. Swaps fire sporadically — faster as
   * intensity rises — for a fluid, dense collage.
   */
  private wakeTick(dt: number): void {
    const stack = this.layerStack;
    if (!stack) return;

    const logical = this.clock * this.tempoMul;
    const s = this.intensity.sample(logical);
    const intensity = s.intensity;

    // --- Discrete events FIRST (they mutate the walker + the layer recipe), so the per-slot
    // fade ramps in stack.update(dt) below ease THIS frame rather than one frame late. The order
    // of the two walker.next() calls — coherence's text beat before the swap's image beat — is
    // load-bearing for determinism: it must not change. ---

    // coherence at troughs: on entering a NEW trough, decide what surfaces; on leaving, release.
    if (s.inTrough && s.troughId !== this.activeTrough) {
      this.activeTrough = s.troughId;
      const kind = coherenceForTrough(this.seed, s.troughId);
      // rhyme converges the walk; a FALSE AWAKENING converges too (the image settles) while the
      // continuous section below drops every treatment to near-zero — "am I awake?".
      this.walker.setConvergence(kind === 'rhyme' || kind === 'awake');
      if (kind === 'awake') {
        this.awakeTroughId = s.troughId;
        this.hooks.setCaption({ whisper: '' }); // the awake moment is wordless
      }
      if (kind === 'phrase') {
        const beat = this.walker.next('text', this.tempoMul);
        this.hooks.setCaption({ whisper: beat.asset.text ?? '' });
      }
    } else if (!s.inTrough && this.activeTrough !== -1) {
      // single-sample exit: we already know this tick is outside any trough.
      this.walker.setConvergence(false);
      this.activeTrough = -1;
      this.awakeTroughId = -1;
    }

    // Hypnagogic onset: 0..1 progress through the opening window (1 once fully "asleep").
    const onset =
      this.clock < this.onsetUntil ? 1 - (this.onsetUntil - this.clock) / ONSET_S : 1;

    // sporadic layer swap; the interval shrinks as intensity rises (and with faster tempo).
    if (this.clock >= this.nextSwapAt) {
      this.swapWakeLayer();
      // Breathing room: slower baseline + a wider range so calm stretches actually linger; a
      // lucid trough holds even longer so the clear image can be taken in.
      let interval = (0.4 + (1 - intensity) * 1.6) / Math.max(0.5, this.tempoMul);
      if (s.inTrough) interval *= 2.0;
      // During onset the imagery is fragmentary: rapid, short-lived flashes cohering into scenes.
      interval *= 0.35 + 0.65 * onset;
      this.nextSwapAt = this.clock + interval;
    }

    // A wake-mode flash-frame clears itself after its brief hold.
    if (this.wakeGhostUntil > 0 && this.clock >= this.wakeGhostUntil) {
      this.compositor.setWakeGhost(null, 0);
      this.wakeGhostUntil = 0;
    }

    // --- Now advance the CONTINUOUS look and the per-slot fade ramps, then capture feedback.
    // Discrete recipe (layer count + per-layer blends + feedback) is held steady between swaps:
    // it's re-rolled only in swapWakeLayer(), so density/blends don't strobe per frame. Re-apply
    // the stored plan each frame (cheap, no re-roll) so toggled layer visibility tracks the maps.
    // Pinned slots are slots whose video hold hasn't expired yet — they are forced into the visible
    // set by applyPlan so a playing clip can't be ranked out of view as newer swaps fire. ---
    const pins = this.activePins();
    const videoFocus = pins.size > 0;
    // Hero presence eases in across the hypnagogic onset (translucent fragments → full scene).
    stack.setHeroCap(onset >= 1 ? 1 : 0.5 + 0.5 * onset);
    if (this.currentPlan) stack.applyPlan(videoFocus ? videoFocusPlan(this.currentPlan) : this.currentPlan, pins);

    // intensity-scaled film: a calm base, warped + graded by the heartbeat. These are the
    // CONTINUOUS params — they keep tracking the freshly sampled intensity every frame. setParams
    // merges, so we only push the channels we own here; the post-FX dream-event engine layers on
    // top. warp is derived directly from intensity (layerPlan's curve: min(1, i*i*0.3)) since the
    // recipe's plan.warp is no longer recomputed per frame.
    // FALSE AWAKENING: every treatment drops to near-zero — the rawest, cleanest the reel ever
    // gets — until the trough releases and the dream pulls back under.
    const falseAwake = s.inTrough && s.troughId === this.awakeTroughId;
    if (falseAwake) {
      this.postfx.setParams(falseAwakeningFilm());
    } else {
      this.postfx.setParams(videoFocus ? videoFocusWakeFilm(intensity) : {
        ...baseWakeFilm(),
        // Keep the media readable: a LOW grade floor at the coherent baseline (the 2026 direction —
        // near-realistic at rest, treatment only at escalation); warp/chroma still surge with the
        // heartbeat. During the hypnagogic onset a touch of extra haze softens the fragments.
        haze: 0.03 + (1 - onset) * 0.08,
        filmGrade: 0.16 - intensity * 0.06,
        warp: Math.min(1, intensity * intensity * 0.3),
        chroma: 0.03 + intensity * 0.40,
        bloom: 0.04 + intensity * 0.16,
      });
    }
    // Gate the post-FX dream-event engine + dust on the heartbeat so swells/specks belong to
    // escalation, not the resting baseline. Classic mode never calls this and keeps full energy.
    this.postfx.setWakeEnergy(falseAwake ? 0 : intensity);

    // "Dream turns to colour": while a colour turn is held, ease the desaturating grade (desat +
    // sepia) away and lift a gentle bloom on a sine hump, so the colorized clip's colour blooms in
    // and relaxes back. Branch-agnostic — reads back the grade the block above just set and scales
    // it, so it works over both the videoFocus and non-focus film. No-op when no turn is active.
    if (this.colorHoldUntil > this.clock && !falseAwake) {
      const env = Math.sin(Math.PI * ((COLOR_HOLD_S - (this.colorHoldUntil - this.clock)) / COLOR_HOLD_S));
      const p = this.postfx.params;
      this.postfx.setParams({
        desat: p.desat * (1 - env),
        sepia: p.sepia * (1 - 0.85 * env),
        bloom: p.bloom + env * 0.12,
      });
    }

    // Datamosh: at the peak of a frenzy the feedback trail re-samples itself displaced along the
    // hero clip's baked flow (or a procedural swirl) — the image dissolving along its own motion.
    stack.setMosh(
      falseAwake ? 0 : moshStrength(intensity, s.regime, this.postfx.params.reduceMotion),
      this.clock,
    );

    // Mood-shaped swap dynamics: tender dreams dissolve long and luminous, fearful escalations
    // cut hard. Presentation-only (fade timing, never selection).
    stack.setFadeRate(
      swapFadeRate(this.lastWakeMood, intensity, s.inTrough, this.postfx.params.reduceMotion),
    );

    if (this.lastWakeMood) {
      const fs = filterStrengths(this.lastWakeMood, s.intensity, s.inTrough);
      const readable = falseAwake
        ? scaleFilterStrengths(fs, 0)
        : videoFocus
          ? scaleFilterStrengths(capDistortion(fs), 0.18)
          : capDistortion(fs);
      this.postfx.setFilterStrengths(readable);
      stack.setFeedback(falseAwake || videoFocus ? 0 : fs.feedback);
    }

    this.driveButterchurn(stack, s.intensity, s.regime, s.inTrough, s.troughId, videoFocus);

    stack.update(dt); // advance per-slot opacity ramps (cross-fade layer swaps)
    stack.captureFeedback(this.compositor.renderer);
  }

  /**
   * Drive the optional psychedelic layer. filterDirector.butterchurnEngaged is the SINGLE decision
   * point (frenzy + high intensity, off under reduced-motion); on a new trough we re-roll a preset
   * deterministically; the blend opacity rises with intensity but is capped so the base image still
   * reads. A null/disabled layer (the default) short-circuits to a hidden overlay — zero effect on
   * the base reel. The whole path is guarded so it can never break the dream.
   */
  private driveButterchurn(
    stack: LayerStack,
    intensity: number,
    regime: IntensityRegime,
    inTrough: boolean,
    troughId: number,
    videoFocus: boolean,
  ): void {
    const bc = this.butterchurn;
    if (!bc) return;
    if (videoFocus) {
      bc.engage(false);
      stack.setPsychedelic(null, 0);
      return;
    }
    const reduce = this.postfx.params.reduceMotion;
    const engaged = butterchurnEngaged(intensity, regime, reduce);
    bc.engage(engaged);
    if (!engaged || !bc.active) {
      stack.setPsychedelic(null, 0);
      return;
    }
    // Re-roll the preset once per trough boundary (deterministic per seed/trough).
    if (inTrough && troughId !== this.bcPresetTrough) {
      this.bcPresetTrough = troughId;
      const roll = makeRng(`${this.seed}:bc:${troughId}`).next();
      bc.selectPreset(butterchurnPresetIndex(roll, 64));
    }
    bc.update();
    // Cap the wash so the picture beneath still reads; eases off inside a coherence trough.
    const opacity = inTrough ? 0.12 : Math.min(0.5, 0.18 + intensity * 0.4);
    stack.setPsychedelic(bc.texture, opacity);
  }

  /**
   * Advance the image walk one beat and bind the resolved texture into the next layer slot.
   * Mirrors imageBeat's mood/audio/caption side-effects so the wake reel still drives the
   * audio bed and on-screen metadata, but composites into the layer fan instead of crossfading.
   */
  private swapWakeLayer(): void {
    const stack = this.layerStack;
    if (!stack) return;

    // Re-roll the discrete recipe ONLY here, when a swap actually fires (a few times/second),
    // then hold it steady between swaps. This advances presRng per-swap (not per-frame) and is
    // what keeps the layer count + blend modes from strobing. Sample intensity on the logical
    // clock so the recipe's density band matches the current heartbeat.
    const sample = this.intensity.sample(this.clock * this.tempoMul);
    const intensity = sample.intensity;
    this.currentPlan = planLayers(intensity, this.presRng);
    // Compute the pinned set here too so the swap-time applyPlan also respects any active
    // video holds — consistent with every other applyPlan call.
    stack.applyPlan(this.currentPlan, this.activePins());

    const beat = this.walker.next('image', this.tempoMul);
    const mood = this.walker.currentMood();
    this.lastWakeMood = mood;
    this.lastMood = mood;
    this.lastIntensity = intensity;
    this.hooks.setMood(mood);
    this.safeAudio(() => this.audio.setMood(mood));
    this.observeMemory(beat.asset);
    this.maybeSummonSprite();

    // Advance the audio walk on this logical visual beat — deterministic cadence.
    // Uses beat.asset.claptext directly so the pick reads the concept for THIS beat.
    if (this.audioWalker && this.mixer) {
      if (onVisualBeat(this.audioCadence, beat.dwellMs)) {
        const pick = this.audioWalker.next(beat.asset.claptext, this.tempoMul, mood);
        if (pick) {
          this.safeAudio(() => this.mixer!.show(pick));
          commitPick(this.audioCadence, pick.dwellMs);
        }
      }
    }

    const { slot, nextCursor } = pickSwapSlot(
      this.layerCursor,
      this.slotHeldUntil,
      this.clock,
      MAX_LAYERS,
    );
    this.layerCursor = nextCursor;
    const asset = beat.asset;
    // The slot is being repurposed — drop any stale video hold now so a pin never props up a
    // non-video texture (the video success branch below re-arms it when a clip actually lands).
    this.slotHeldUntil[slot] = 0;

    // Wake-mode gl-transition: on a CALM single-hero swap, route the hero handoff through the
    // mood-mapped transition catalog (the same brain classic mode uses) instead of a plain
    // opacity cross-fade. Gated to layerCount===1 so the wipe never covers the dense collage —
    // there the fade is kept. The presRng roll keeps selection deterministic per seed; timing may
    // vary (presentation only). `heroFrom` is the outgoing hero, captured BEFORE the swap writes.
    const reduce = this.postfx.params.reduceMotion;
    const useTransition = this.currentPlan.layerCount === 1;
    const heroFrom = useTransition ? stack.currentHeroTexture() : null;
    const transitionName = useTransition
      ? pickTransition(mood, intensity, sample.inTrough, this.presRng.next(), reduce)
      : 'fade';
    const transitionDurSec = Math.max(
      0.3,
      Math.min(1.5, 2.5 / swapFadeRate(mood, intensity, sample.inTrough, reduce)),
    );
    const beginHeroTransition = (to: THREE.Texture): void => {
      if (useTransition) stack.beginTransition(heroFrom, to, transitionName, transitionDurSec);
    };

    if (beat.titleCard || asset.type === 'titlecard') {
      const tex = this.makeTitleCard(asset.text ?? '', mood);
      stack.setLayerTexture(slot, tex);
      beginHeroTransition(tex);
      this.hooks.setCaption({
        reel: beat.titleCard ? 'INTERTITLE' : reelLabel(asset),
        source: asset.source,
        whisper: asset.text ?? '',
        license: asset.license,
        attribution: ccByAttribution(asset),
        attributionUrl: asset.attributionUrl,
      });
      return;
    }

    if (asset.type === 'procedural') {
      const src = this.proc(asset.id, asset.kind ?? 'fog');
      this.markLive(src);
      stack.setLayerTexture(slot, src.texture);
      beginHeroTransition(src.texture);
    } else if (asset.type === 'image' && asset.src) {
      void this.compositor.showImage(asset.src, asset.grade).then((res) => {
        if (res.ok) {
          stack.setLayerTexture(slot, res.texture);
          beginHeroTransition(res.texture);
          // 2.5D: bind the baked depth map once it's in (guarded — the slot may have moved on).
          this.sideTexture(asset.depthSrc, asset.id, this.depthTex, this.depthLoading, (d) =>
            stack.setLayerDepth(slot, d, res.texture),
          );
          // Non-video asset becomes the displayed image — clear film-clip audio.
          this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
        } else {
          // deterministic procedural fallback so the slot is never empty
          const kind = fallbackKindFor(asset.id);
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          stack.setLayerTexture(slot, src.texture);
          this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
        }
      });
    } else if (asset.type === 'video' && asset.src) {
      // Rare "dream turns to colour": on a gentle low-intensity beat, a clip with a baked colorized
      // variant may bloom into colour. Seeded + cooldown-gated so it stays a special moment; the
      // continuous grade section eases the desaturation away for COLOR_HOLD_S. Takes precedence
      // over the slow-motion pick (both are gentle-register, colour is the rarer event).
      const colorTurn =
        !!asset.colorSrc &&
        preferColor(mood, intensity) &&
        this.clock >= this.colorCooldownUntil &&
        this.colorRng.next() < COLOR_TURN_PROB;
      if (colorTurn) {
        this.colorCooldownUntil = this.clock + COLOR_TURN_COOLDOWN_S;
        this.colorHoldUntil = this.clock + COLOR_HOLD_S;
      }
      // Gentle-register beats prefer the clip's slow-motion variant when one is baked. The pick
      // is deterministic (mood + intensity are logical state); shot windows don't apply to the
      // time-stretched/colorized variants, so they play whole.
      const slow = !colorTurn && asset.slowSrc && preferSlow(mood, intensity) ? asset.slowSrc : undefined;
      const variant = colorTurn ? asset.colorSrc : slow;
      void this.compositor
        .showVideo(variant ?? asset.src, asset.grade, variant ? undefined : this.pickShot(asset))
        .then((res) => {
        if (res.ok) {
          stack.setLayerTexture(slot, res.texture);
          beginHeroTransition(res.texture);
          // 2.5D: midpoint-frame depth (pipeline/embed/depth.py) drifts the moving image too.
          this.sideTexture(asset.depthSrc, asset.id, this.depthTex, this.depthLoading, (d) =>
            stack.setLayerDepth(slot, d, res.texture),
          );
          this.slotHeldUntil[slot] = this.clock + (sample.inTrough ? 13.0 : 9.0);
          // Datamosh direction: the hero clip's baked flow field, when it carries one (else the
          // material's procedural swirl stands in). Caller-owned cache; never disposed by the fb.
          if (asset.flowSrc) {
            this.sideTexture(asset.flowSrc, asset.id, this.flowTex, this.flowLoading, (f) =>
              stack.setMoshFlow(f),
            );
          }
          // Route film-clip native audio through the mixer (best-effort).
          const el = res.texture.userData.video as HTMLVideoElement | undefined;
          this.safeAudio(() => this.mixer?.setFilmClipAudio(true, el));
        } else {
          const kind = fallbackKindFor(asset.id);
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          stack.setLayerTexture(slot, src.texture);
          this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
        }
      });
    } else {
      // image with no src, or any other shape -> a Bodoni card so the slot still shows something
      const tex = this.makeTitleCard(asset.text ?? '', mood);
      stack.setLayerTexture(slot, tex);
    }

    this.hooks.setCaption({
      reel: reelLabel(asset),
      source: asset.source,
      license: asset.license,
      attribution: ccByAttribution(asset),
      attributionUrl: asset.attributionUrl,
    });

    // Rare flash-frame: a demoted still may flash over the fan this beat (video-first policy —
    // this is the only way `image` assets surface in wake mode). Per swap beat, so the seeded
    // roll cadence follows the dream script, not the frame rate.
    this.maybeFlashFrame(sample.intensity, true);
  }

  /**
   * Deliver an asset's baked side-texture (depth map or flow) from a cache, loading it once on
   * miss. `cb` fires only on success — synchronously when cached, else after the async load; the
   * caller must re-validate its target (e.g. LayerStack.setLayerDepth's expectMap guard).
   */
  private sideTexture(
    src: string | undefined,
    id: string,
    cache: Map<string, THREE.Texture>,
    loading: Set<string>,
    cb: (tex: THREE.Texture) => void,
  ): void {
    if (!src) return;
    const cached = cache.get(id);
    if (cached) {
      cb(cached);
      return;
    }
    if (loading.has(id)) return;
    loading.add(id);
    void loadImageTexture(src).then((res) => {
      loading.delete(id);
      if (!res.ok) return;
      res.texture.userData.ownedByCompositor = false; // conductor-owned cache
      cache.set(id, res.texture);
      cb(res.texture);
    });
  }

  /** Returns the set of slots whose video hold hasn't expired yet. */
  private activePins(): Set<number> {
    const pins = new Set<number>();
    for (let i = 0; i < this.slotHeldUntil.length; i++) {
      if (this.slotHeldUntil[i] > this.clock) pins.add(i);
    }
    return pins;
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
    // Classic mode has no intensity engine; surreality stands in as the intensity proxy for the
    // filterDirector transition/procedural choices.
    this.lastMood = mood;
    this.lastIntensity = this.surreality;
    this.hooks.setMood(mood);
    this.safeAudio(() => this.audio.setMood(mood));
    this.observeMemory(beat.asset);
    this.maybeSummonSprite();
    this.applyMoodToFilm(mood, beat.asset);

    // Advance the audio walk on this logical visual beat — deterministic cadence.
    // Audio picks are driven by beat.dwellMs (a pure function of the asset and tempoMul),
    // not by wall-clock dt, so the audio sequence is a deterministic function of the seed.
    if (this.audioWalker && this.mixer) {
      if (onVisualBeat(this.audioCadence, beat.dwellMs)) {
        const pick = this.audioWalker.next(beat.asset.claptext, this.tempoMul, mood);
        if (pick) {
          this.safeAudio(() => this.mixer!.show(pick));
          commitPick(this.audioCadence, pick.dwellMs);
        }
      }
    }

    // Mood-mapped transition: filterDirector is the single source of truth. presRng supplies the
    // seeded roll so the choice stays deterministic per seed; reduced-motion gets the gentle set.
    const transition = pickTransition(
      mood,
      this.surreality,
      false,
      this.presRng.next(),
      this.postfx.params.reduceMotion,
    );

    if (beat.titleCard) {
      // Cut to a black Bodoni intertitle instead of an image.
      const tex = this.makeTitleCard(beat.asset.text ?? '', mood);
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
    // A demoted still may claim the ghost slot this beat as a rare flash-frame; otherwise the slot
    // keeps its intensity-gated procedural echo (or clears).
    if (!this.maybeFlashFrame(intensity)) {
      if (intensity > 0.58) {
        const tex = this.textureForAsset(beat.asset);
        if (tex) this.compositor.setGhost(tex, 0.18 + intensity * 0.32);
      } else {
        this.compositor.setGhost(null, 0);
      }
    }
    this.nextGhostAt = this.clock + beat.dwellMs / 1000;
  }

  /** Try to surface a DEMOTED still as a brief ghost-layer flash-frame (the only place `image`
   *  assets appear under the video-first policy). Returns true if it took the ghost slot this beat.
   *  Deterministic (seeded `flashRng`), bounded by `FLASH_FRAME_COOLDOWN_S`, and off under reduced
   *  motion. The seeded decision (roll + cooldown) is independent of async load timing, so the dream
   *  script stays reproducible per seed even though a still may only become visible a beat later.
   *  In WAKE mode (`wake=true`, called once per swap beat) the still lands on the compositor's
   *  wake-ghost overlay — above the layer fan — and self-clears after WAKE_FLASH_HOLD_S. */
  private maybeFlashFrame(intensity: number, wake = false): boolean {
    if (this.flashPool.length === 0 || this.postfx.params.reduceMotion) return false;
    if (this.clock < this.flashCooldownUntil) return false;
    if (this.flashRng.next() > FLASH_FRAME_PROB) return false;

    const asset = this.flashPool[this.flashRng.int(this.flashPool.length)];
    if (!asset.src) return false;
    this.flashCooldownUntil = this.clock + FLASH_FRAME_COOLDOWN_S;
    const opacity = 0.14 + intensity * 0.22;

    const cached = this.flashTex.get(asset.id);
    if (cached) {
      // 2.5D flash: a depth-bound still drifts dimensionally for its brief hold.
      const depth = asset.depthSrc ? (this.depthTex.get(asset.id) ?? null) : null;
      if (wake) {
        this.compositor.setWakeGhost(cached, opacity, depth);
        this.wakeGhostUntil = this.clock + WAKE_FLASH_HOLD_S;
      } else {
        this.compositor.setGhost(cached, opacity, depth);
      }
      this.postfx.triggerSplice(0.4); // subliminal flash read (photosensitivity-guarded in postfx)
      return true;
    }
    // Not loaded yet: kick off the (cached) load so a later flash can show it. We still consumed the
    // seeded roll + cooldown, so the cadence is reproducible; leave the ghost slot unchanged for now.
    if (!this.flashLoading.has(asset.id)) {
      this.flashLoading.add(asset.id);
      void loadImageTexture(asset.src).then((res) => {
        this.flashLoading.delete(asset.id);
        if (res.ok) this.flashTex.set(asset.id, res.texture);
      });
      // Warm the depth cache alongside so a later flash of this still can drift in 2.5D.
      this.sideTexture(asset.depthSrc, asset.id, this.depthTex, this.depthLoading, () => {});
    }
    return true;
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
      // Non-video: clear any active film-clip audio.
      this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
      return;
    }
    if (asset.type === 'image' && asset.src) {
      void this.compositor.showImage(asset.src, asset.grade).then((res) => {
        if (res.ok) {
          this.compositor.crossfadeTo(res.texture, transition, this.crossfadeMs());
        } else {
          // fall back to a deterministic procedural so the reel never breaks
          const kind = fallbackKindFor(asset.id);
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          this.compositor.crossfadeTo(src.texture, transition, this.crossfadeMs());
        }
        // Non-video: clear any active film-clip audio.
        this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
      });
      return;
    }
    if (asset.type === 'video' && asset.src) {
      void this.compositor.showVideo(asset.src, asset.grade, this.pickShot(asset)).then((res) => {
        if (res.ok) {
          this.compositor.crossfadeTo(res.texture, transition, this.crossfadeMs());
          // Route film-clip native audio through the mixer (best-effort).
          const el = res.texture.userData.video as HTMLVideoElement | undefined;
          this.safeAudio(() => this.mixer?.setFilmClipAudio(true, el));
        } else {
          const kind = fallbackKindFor(asset.id);
          const src = this.proc(`fallback:${asset.id}`, kind);
          this.markLive(src);
          this.compositor.crossfadeTo(src.texture, transition, this.crossfadeMs());
          // Video failed to load; treat as non-video.
          this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
        }
      });
      return;
    }
    // titlecard-type asset used as a visual, or anything else -> text card
    const tex = this.makeTitleCard(asset.text ?? '', this.lastMood ?? blankMood());
    this.compositor.crossfadeTo(tex, transition, this.crossfadeMs());
    // Non-video: clear any active film-clip audio.
    this.safeAudio(() => this.mixer?.setFilmClipAudio(false));
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
      vignette: 0.42 + mood.ominous * 0.32 + mood.fear * 0.18,
      grain: 0.16 + (1 - mood.tender) * 0.16 + mood.mechanical * 0.06 + mood.absurdity * 0.04,
      sepia: 0.36 + mood.nostalgic * 0.22 + mood.loss * 0.1,
      desat: 0.28 + mood.melancholy * 0.22 + mood.loss * 0.14,
      halation: 0.25 + mood.tender * 0.32 + mood.love * 0.2 + mood.joy * 0.1,
      scanline: 0.08 + mood.mechanical * 0.16,
      bloom: 0.3 + mood.tender * 0.5 + mood.joy * 0.2 + s * 0.4,
      haze: 0.14 + mood.melancholy * 0.24 + mood.nostalgic * 0.16 + mood.loss * 0.12 + s * 0.18,
      lightLeak: 0.18 + mood.nostalgic * 0.3 + mood.joy * 0.15 + s * 0.3,
      tint: 0.18 + mood.uncanny * 0.3 + mood.strange * 0.22 + s * 0.2,
      chroma: 0.15 + mood.uncanny * 0.5 + mood.fear * 0.25 + s * 0.35,
      exposure: 1 + mood.tender * 0.06 + mood.joy * 0.04 - mood.fear * 0.03,
      breathe: 0.4 + s * 0.5,
    });
    this.postfx.setGradeSepia(parseGrade(asset.grade));

    // Punctuate the cut with an occasional one-shot dream swell; more likely as surreality
    // rises. Uncanny moods lean toward colour-fringe surges, tender ones toward soft blooms.
    if (this.presRng.next() < 0.18 + s * 0.4) {
      const roll = this.presRng.next();
      const target =
        roll < 0.25 + mood.uncanny * 0.3 + mood.strange * 0.15
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
    return this.styled(src);
  }

  /** Deterministically choose one baked interior shot for a video (so it plays a real shot, not the
   *  film's leader). Undefined when the asset carries no shots → the video plays from 0 as before. */
  private pickShot(asset: Asset): Shot | undefined {
    const shots = asset.shots;
    if (!shots || shots.length === 0) return undefined;
    return shots[this.shotRng.int(shots.length)];
  }

  /**
   * Apply the current emotion+intensity procedural params (filterDirector is the single source of
   * truth) to a source. With no mood yet (e.g. the academy leader on first play) it stays neutral,
   * so the source renders exactly as it did before this variation wiring.
   */
  private styled(src: ProceduralSource): ProceduralSource {
    if (this.lastMood) src.setParams(proceduralParams(this.lastMood, this.lastIntensity));
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

  private makeTitleCard(text: string, mood: Record<MoodAxis, number>): THREE.CanvasTexture {
    const palette = titleCardPalette(mood);
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 576;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = palette.ink;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = palette.text;
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
    ctx.strokeStyle = palette.frame;
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

/**
 * Calm base film levels for wake mode: the old-cinema treatment is dialled back (low vignette /
 * grain / sepia / scanline) so the intensity-scaled filmGrade/warp/chroma/bloom — added by the
 * per-tick setParams patch — and the dense layer fan carry the look. setParams merges, so any
 * params not named here keep their previous value (mood may still nudge them).
 */
function baseWakeFilm(): Partial<FilmParams> {
  return {
    vignette: 0.16,
    grain: 0.06,
    sepia: 0.08,
    scanline: 0.02,
    desat: 0.08,
    halation: 0.05,
    haze: 0.03,
    flicker: 0.02,
    // setParams merges, so without these the wake reel inherits the CLASSIC defaults
    // (lightLeak 0.3 / tint 0.25 / breathe 0.5) — a constant warm old-film wash that fights the
    // coherent baseline. Own them here at near-off levels; escalation adds its own treatment.
    lightLeak: 0.03,
    tint: 0.03,
    breathe: 0.12,
    exposure: 1,
  };
}

/**
 * The FALSE-AWAKENING film patch: everything at (or near) zero. Not the videoFocus grade — this
 * is the one moment the reel is allowed to look like plain unfiltered footage, so the return of
 * the treatment when the trough releases reads as sinking back into the dream.
 */
function falseAwakeningFilm(): Partial<FilmParams> {
  return {
    vignette: 0.05,
    grain: 0.015,
    sepia: 0,
    scanline: 0,
    desat: 0,
    halation: 0,
    haze: 0,
    flicker: 0,
    lightLeak: 0,
    tint: 0,
    breathe: 0.04,
    exposure: 1,
    filmGrade: 0.02,
    warp: 0,
    chroma: 0.01,
    bloom: 0.03,
  };
}

function videoFocusPlan(plan: LayerPlan): LayerPlan {
  return {
    ...plan,
    layerCount: 1,
    feedback: 0,
    warp: 0,
    blends: ['normal'],
  };
}

function scaleFilterStrengths(fs: FilterStrengths, scale: number): FilterStrengths {
  return {
    kaleidoscope: fs.kaleidoscope * scale,
    liquid: fs.liquid * scale,
    solarize: fs.solarize * scale,
    melt: fs.melt * scale,
    posterize: fs.posterize * scale,
    feedback: fs.feedback * scale,
  };
}

function videoFocusWakeFilm(intensity: number): Partial<FilmParams> {
  return {
    ...baseWakeFilm(),
    grain: 0.025,
    sepia: 0.04,
    scanline: 0.005,
    desat: 0.035,
    halation: 0.025,
    haze: 0.01,
    lightLeak: 0.025,
    tint: 0.035,
    breathe: 0.1,
    filmGrade: 0.12,
    warp: Math.min(0.03, intensity * intensity * 0.06),
    chroma: 0.04 + intensity * 0.06,
    bloom: 0.04 + intensity * 0.06,
  };
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

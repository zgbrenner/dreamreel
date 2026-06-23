// app/src/audio/mixer.ts
// Real-time audio bus graph: hangs music/foley/voice/filmclip buses off the existing Tone
// master Gain, routes AudioPicks to their bus, drives the AudioPool, and applies busGainsDb
// (ramped) as focus changes.
//
// Design notes:
//  - Crossfade on music/voice swap: when a new pick arrives for a bus that already has an
//    active source, we ramp the bus gain to 0, disconnect+pause the old source node, then
//    connect the new source node and ramp the bus back to the ducked level. This is a
//    "dip-through-silence" crossfade on the shared bus gain — clean and click-free.
//  - MediaElementSource lifecycle: the Web Audio API throws if you call
//    createMediaElementSource() twice on the same HTMLVideoElement. We maintain a WeakMap
//    of element -> MediaElementAudioSourceNode and reuse the existing node on repeat calls.
//  - acquire-failure swallowing: show() wraps pool.acquire() in a void-returning async
//    IIFE; any rejection is caught and silently dropped so the caller is never disturbed.
//  - loopable: after acquiring, we set el.loop on the underlying HTMLAudioElement via the
//    internal PooledSrc wrapper, which exposes both the sourceNode and the el.

import * as Tone from 'tone';
import { AudioPool, type PooledAudio } from './AudioPool';
import { busGainsDb, type BusName, type FocusState } from './ducking';
import type { AudioPick } from '../dream/audioWalker';
import type { AudioAsset } from '../manifest/types';

const RAMP = 0.4; // seconds — click-free bus-gain ramps
const POOL_CAP = 3;

// ---------------------------------------------------------------------------
// Pure reducer — the only unit-tested part
// ---------------------------------------------------------------------------

export function nextFocus(
  prev: FocusState,
  kind: AudioAsset['kind'] | 'filmclip',
  active: boolean,
): FocusState {
  const next = { ...prev };
  if (kind === 'music') next.music = active;
  else if (kind === 'foley') next.foley = active;
  else if (kind === 'voice') next.voice = active;
  else if (kind === 'filmclip') next.filmclip = active;
  return next;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MixerDeps {
  master: Tone.Gain;
  pool?: AudioPool;
}

export interface Mixer {
  show(pick: AudioPick): void;
  setFilmClipAudio(active: boolean, el?: HTMLVideoElement): void;
  setEnabled(on: boolean): void;
  setArchiveAudio(on: boolean): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal extended PooledAudio that carries Tone graph wiring.
// Not exported — this is an implementation detail.
// ---------------------------------------------------------------------------

interface PooledSrc extends PooledAudio {
  readonly sourceNode: MediaElementAudioSourceNode;
  readonly el: HTMLAudioElement;
}

// ---------------------------------------------------------------------------
// Default load function — streaming via HTMLAudioElement
// ---------------------------------------------------------------------------

async function defaultLoad(url: string): Promise<PooledAudio> {
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.src = url;
  el.loop = false;
  let disposed = false;

  // Create the MediaElementAudioSourceNode immediately.
  // Tone graph routing (connecting to a bus) is done by show() once the bus is known.
  const rawCtx = Tone.getContext().rawContext as unknown as AudioContext;
  const sourceNode = rawCtx.createMediaElementSource(el);

  // Start buffering early; bus gain gates the audible output.
  await el.play().catch(() => {
    // autoplay / gesture race — harmless; bus gain gates audibility.
  });

  const pooled: PooledSrc = {
    url,
    sourceNode,
    el,
    play() {
      if (!disposed) void el.play().catch(() => {});
    },
    pause() {
      el.pause();
    },
    get paused() {
      return el.paused;
    },
    dispose() {
      disposed = true;
      try { sourceNode.disconnect(); } catch { /* already disconnected */ }
      el.pause();
      el.removeAttribute('src');
      el.load();
    },
  };
  return pooled;
}

// ---------------------------------------------------------------------------
// createMixer — the Tone graph
// ---------------------------------------------------------------------------

export function createMixer(deps: MixerDeps): Mixer {
  // One Tone.Gain per bus, all connected to deps.master.
  const buses: Record<BusName, Tone.Gain> = {
    // bed carries no source yet; the synth engine's bed is not rerouted through it, so its
    // computed duck trim is currently inert — bed-under-samples ducking is DEFERRED this round.
    bed: new Tone.Gain(1).connect(deps.master),
    music: new Tone.Gain(1).connect(deps.master),
    foley: new Tone.Gain(1).connect(deps.master),
    voice: new Tone.Gain(1).connect(deps.master),
    filmclip: new Tone.Gain(1).connect(deps.master),
  };

  const pool = deps.pool ?? new AudioPool({ cap: POOL_CAP, load: defaultLoad });

  let focus: FocusState = { voice: false, filmclip: false, music: false, foley: false };
  let enabled = true;
  let archive = true;

  // Track currently active source per bus for crossfade/disconnect.
  const activeSrc: Partial<Record<BusName, PooledSrc>> = {};

  // Per-bus epoch counter: incremented each time show() is called for that bus.
  // The async IIFE captures its epoch at dispatch time; if the counter has advanced
  // by the time pool.acquire() resolves, a newer show() has superseded this one and
  // we discard the acquired node rather than mutating the bus graph.
  const busEpoch: Record<BusName, number> = { bed: 0, music: 0, foley: 0, voice: 0, filmclip: 0 };

  // Per-<video> source nodes — reuse to avoid the "createMediaElementSource twice" error.
  const videoSources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
  let filmclipVideoEl: HTMLVideoElement | null = null;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function applyDuck(): void {
    const g = busGainsDb(focus);
    for (const name of Object.keys(buses) as BusName[]) {
      buses[name].gain.rampTo(enabled ? Tone.dbToGain(g[name]) : 0, RAMP);
    }
  }

  function silenceBus(name: BusName): void {
    buses[name].gain.rampTo(0, RAMP);
  }

  function connectToBus(sourceNode: MediaElementAudioSourceNode, busName: BusName): void {
    // buses[busName].input is the underlying gain AudioParam's parent AudioNode.
    // Tone exposes .input on ToneAudioNode; cast to access it.
    const busNode = buses[busName] as unknown as { input: AudioNode };
    try {
      sourceNode.connect(busNode.input);
    } catch {
      // Already connected — safe to ignore.
    }
  }

  function disconnectFromBus(sourceNode: MediaElementAudioSourceNode): void {
    try { sourceNode.disconnect(); } catch { /* already disconnected */ }
  }

  // -------------------------------------------------------------------------
  // show(pick)
  // -------------------------------------------------------------------------

  function show(pick: AudioPick): void {
    const kind: AudioAsset['kind'] = pick.asset.kind;
    const busName: BusName = kind;
    const oldSrc = activeSrc[busName];

    // Increment the epoch for this bus and capture it before yielding to the microtask
    // queue. Any later show() call on the same bus will increment again, making myEpoch
    // stale and causing the superseded acquire to be discarded without touching the graph.
    const myEpoch = (busEpoch[busName] += 1);

    void (async () => {
      let raw: PooledAudio;
      try {
        raw = await pool.acquire(pick.asset.src);
      } catch {
        // Swallow: a failed acquire is silently skipped — never throw into the caller.
        return;
      }

      // Guard: if a newer show() for this bus completed its acquire after ours started,
      // discard the node we just loaded rather than clobbering the graph it already wired.
      if (busEpoch[busName] !== myEpoch) {
        try { (raw as PooledSrc).dispose?.(); } catch { /* ignore */ }
        return;
      }

      // The defaultLoad function returns a PooledSrc; pools injected in tests may not.
      // We handle both cases: if _sourceNode is present, wire it; otherwise just play.
      const src = raw as PooledSrc;

      // Crossfade dip: ramp bus to 0, swap source, ramp back up.
      silenceBus(busName);

      // Disconnect + pause the previous occupant.
      if (oldSrc?.sourceNode) {
        disconnectFromBus(oldSrc.sourceNode);
        oldSrc.pause();
      }

      // Connect new source node into the bus (if available).
      if (src.sourceNode) {
        connectToBus(src.sourceNode, busName);
      }

      // Apply loop flag from the asset.
      if (src.el) {
        src.el.loop = pick.asset.loopable;
      }

      activeSrc[busName] = src;

      // Update focus: music/foley signal presence; voice signals focus.
      focus = nextFocus(focus, kind, true);
      // This ramps the bus back up from 0 to the correct ducked level.
      applyDuck();
    })();
  }

  // -------------------------------------------------------------------------
  // setFilmClipAudio(active, el?)
  // -------------------------------------------------------------------------

  function setFilmClipAudio(active: boolean, el?: HTMLVideoElement): void {
    if (!active) {
      if (filmclipVideoEl) {
        const node = videoSources.get(filmclipVideoEl);
        if (node) disconnectFromBus(node);
        filmclipVideoEl = null;
      }
      focus = nextFocus(focus, 'filmclip', false);
      applyDuck();
      return;
    }

    // active=true but archive off or mixer disabled → keep film-clip bus silent.
    if (!archive || !enabled) {
      focus = nextFocus(focus, 'filmclip', false);
      applyDuck();
      return;
    }

    if (!el) return;

    // Disconnect any prior video element that's no longer the hero.
    if (filmclipVideoEl && filmclipVideoEl !== el) {
      const oldNode = videoSources.get(filmclipVideoEl);
      if (oldNode) disconnectFromBus(oldNode);
    }

    // Reuse or create the MediaElementAudioSourceNode for this element.
    let sourceNode = videoSources.get(el);
    if (!sourceNode) {
      try {
        const rawCtx = Tone.getContext().rawContext as unknown as AudioContext;
        sourceNode = rawCtx.createMediaElementSource(el);
        videoSources.set(el, sourceNode);
      } catch {
        // Web Audio threw (e.g. element already belongs to another context). Skip silently.
        return;
      }
    }
    if (!sourceNode) return;

    connectToBus(sourceNode, 'filmclip');
    filmclipVideoEl = el;
    focus = nextFocus(focus, 'filmclip', true);
    applyDuck();
  }

  // -------------------------------------------------------------------------
  // setEnabled(on)
  // -------------------------------------------------------------------------

  function setEnabled(on: boolean): void {
    enabled = on;
    applyDuck();
  }

  // -------------------------------------------------------------------------
  // setArchiveAudio(on)
  // -------------------------------------------------------------------------

  function setArchiveAudio(on: boolean): void {
    archive = on;
    if (!on) {
      focus = nextFocus(focus, 'filmclip', false);
      silenceBus('filmclip');

      if (filmclipVideoEl) {
        const node = videoSources.get(filmclipVideoEl);
        if (node) disconnectFromBus(node);
        filmclipVideoEl = null;
      }

      // Re-apply for remaining buses (music/foley may unduck now filmclip is gone).
      applyDuck();
    }
  }

  // -------------------------------------------------------------------------
  // pause() / resume() / dispose()
  // -------------------------------------------------------------------------

  function pause(): void {
    pool.pauseAll();
  }

  function resume(): void {
    pool.resumeAll();
  }

  function dispose(): void {
    pool.dispose();
    for (const name of Object.keys(buses) as BusName[]) {
      buses[name].dispose();
    }
  }

  // Apply initial duck levels (no focus active => just the ambient trims).
  applyDuck();

  return {
    show,
    setFilmClipAudio,
    setEnabled,
    setArchiveAudio,
    pause,
    resume,
    dispose,
  };
}

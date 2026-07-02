// app/src/ui/Gate.tsx
import { useEffect, useRef } from 'react';
import type { Manifest } from '../manifest/types';
import { useStore } from '../state/store';
import { Compositor } from '../render/Compositor';
import { PostFX } from '../render/postfx';
import { AudioEngine } from '../audio/engine';
import { DreamConductor } from '../dream/conductor';
import { deriveSeedParams } from '../dream/seedParams';
import { readShareState } from '../state/url';
import { composePoster, downloadBlob, posterFilename, shareUrlFor } from './poster';

/**
 * The luminous projection gate: hosts the compositor canvas and the idle screen. On mount it
 * constructs the imperative engines (compositor, post-FX, audio, conductor), wires them to the
 * store, and tears them down on unmount. Clicking the gate or pressing Space toggles play.
 */
export function Gate({ manifest }: { manifest: Manifest }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playing = useStore((s) => s.playing);
  // Ambient/TV mode engage hook — set by the engine effect, invoked from the gate click (a real
  // user gesture, which fullscreen requires). No-op when ?ambient=1 is not set.
  const ambientEngageRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const compositor = new Compositor();
    compositor.init(canvas);
    const postfx = new PostFX(compositor);
    const audio = new AudioEngine();

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyReduce = () => postfx.setIntensity(reduce.matches);
    applyReduce();
    reduce.addEventListener('change', applyReduce);

    const s = useStore.getState();
    // Surreality + tempo are this dream's character, derived from its seed — not user controls.
    // Archive is always on (no procedural-only toggle); wake is a non-UI engine mode flag.
    const { surreality, tempo } = deriveSeedParams(s.seed);
    const conductor = new DreamConductor(
      manifest,
      compositor,
      postfx,
      audio,
      { setCaption: s._setCaption, setMood: s._setMood },
      {
        seed: s.seed,
        surreality,
        tempoMul: tempo,
        archiveOn: true,
        wake: readShareState().wake,
        butterchurn: readShareState().butterchurn,
      },
    );
    useStore.getState().attachRuntime(conductor);
    // Render a held first frame even before play.
    compositor.start();

    const resize = () => compositor.setSize(wrap.clientWidth, wrap.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // "p" downloads a dream poster — a hidden key, not visible chrome, so the single-verb UX
    // holds. The WebGL context has preserveDrawingBuffer=false, so the canvas is only readable
    // immediately after a render: a one-shot frame listener re-renders synchronously and reads
    // the pixels back before returning to the browser.
    const onPosterKey = (e: KeyboardEvent) => {
      if (e.key !== 'p' && e.key !== 'P') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      const off = compositor.addFrameListener(() => {
        off();
        let frame: string | null = null;
        try {
          compositor.renderFrame(compositor.renderer);
          frame = compositor.renderer.domElement.toDataURL('image/png');
        } catch {
          frame = null; // capture is best-effort; never disturb the reel
        }
        if (!frame) return;
        const { seed, caption } = useStore.getState();
        void composePoster({
          frame,
          seed,
          whisper: caption.whisper,
          shareUrl: shareUrlFor(seed, window.location.origin, window.location.pathname),
        })
          .then((blob) => {
            if (blob) downloadBlob(blob, posterFilename(seed));
          })
          .catch(() => {
            /* best-effort */
          });
      });
    };
    window.addEventListener('keydown', onPosterKey);

    // Ambient/TV mode (?ambient=1): fullscreen + screen wake lock, both feature-detected and
    // best-effort. The wake lock follows play state (release on pause) and is re-acquired when
    // the document becomes visible again.
    let ambientCleanup: (() => void) | null = null;
    if (readShareState().ambient) {
      let sentinel: WakeLockSentinel | null = null;
      let wantLock = false;
      const releaseLock = () => {
        wantLock = false;
        const s2 = sentinel;
        sentinel = null;
        if (s2) s2.release().catch(() => {});
      };
      const requestLock = () => {
        wantLock = true;
        if (sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') {
          return;
        }
        navigator.wakeLock
          .request('screen')
          .then((lock) => {
            if (!wantLock) {
              lock.release().catch(() => {});
              return;
            }
            sentinel = lock;
            lock.addEventListener('release', () => {
              if (sentinel === lock) sentinel = null;
            });
          })
          .catch(() => {
            /* denied/unsupported — silent */
          });
      };
      const onVisibility = () => {
        if (document.visibilityState === 'visible' && wantLock) requestLock();
      };
      document.addEventListener('visibilitychange', onVisibility);
      const unsubPlaying = useStore.subscribe((st, prev) => {
        if (st.playing === prev.playing) return;
        if (st.playing) requestLock();
        else releaseLock();
      });
      ambientEngageRef.current = () => {
        const root = document.documentElement;
        if (!document.fullscreenElement && typeof root.requestFullscreen === 'function') {
          root.requestFullscreen().catch(() => {});
        }
        requestLock();
      };
      ambientCleanup = () => {
        ambientEngageRef.current = null;
        unsubPlaying();
        document.removeEventListener('visibilitychange', onVisibility);
        releaseLock();
      };
    }

    return () => {
      window.removeEventListener('keydown', onPosterKey);
      ambientCleanup?.();
      ro.disconnect();
      reduce.removeEventListener('change', applyReduce);
      useStore.getState().attachRuntime(null);
      conductor.dispose();
      postfx.dispose();
      compositor.dispose();
      audio.dispose();
    };
  }, [manifest]);

  const togglePlay = useStore((st) => st.togglePlay);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden bg-ink"
      role="button"
      tabIndex={0}
      aria-label={playing ? 'Pause dream' : 'Play dream'}
      onClick={(e) => {
        // ignore clicks that originate on the control panel
        if ((e.target as HTMLElement).closest('[aria-label="Projector controls"]')) return;
        const willPlay = !useStore.getState().playing;
        togglePlay();
        // Ambient mode engages fullscreen + wake lock here, inside a real click gesture.
        if (willPlay) ambientEngageRef.current?.();
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* Gate glow frame */}
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_60px_rgba(0,0,0,0.85)]" />

      {!playing && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 text-center">
          <h1 className="animate-flicker font-title text-6xl uppercase tracking-intertitle text-lamp text-shadow-glow sm:text-8xl">
            Dreamreel
          </h1>
          <p className="max-w-md font-drift text-lg italic text-bone/70">
            a projection from the public domain — press play and let it dream
          </p>
          <div className="mt-2 font-mono text-xs uppercase tracking-[0.3em] text-amber/70">
            ▶ click the gate or press space
          </div>
        </div>
      )}
    </div>
  );
}

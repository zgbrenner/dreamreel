// app/src/ui/Gate.tsx
import { useEffect, useRef } from 'react';
import type { Manifest } from '../manifest/types';
import { useStore } from '../state/store';
import { Compositor } from '../render/Compositor';
import { PostFX } from '../render/postfx';
import { AudioEngine } from '../audio/engine';
import { DreamConductor } from '../dream/conductor';
import { readShareState } from '../state/url';

/**
 * The luminous projection gate: hosts the compositor canvas and the idle screen. On mount it
 * constructs the imperative engines (compositor, post-FX, audio, conductor), wires them to the
 * store, and tears them down on unmount. Clicking the gate or pressing Space toggles play.
 */
export function Gate({ manifest }: { manifest: Manifest }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playing = useStore((s) => s.playing);

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
    const conductor = new DreamConductor(
      manifest,
      compositor,
      postfx,
      audio,
      { setCaption: s._setCaption, setMood: s._setMood },
      { seed: s.seed, surreality: s.surreality, tempoMul: s.tempoMul, archiveOn: s.archiveOn, wake: readShareState().wake },
    );
    useStore.getState().attachRuntime(conductor);
    // Render a held first frame even before play.
    compositor.start();

    const resize = () => compositor.setSize(wrap.clientWidth, wrap.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    return () => {
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
        togglePlay();
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

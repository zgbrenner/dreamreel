// app/src/dev/Harness.tsx
/* eslint-disable react-refresh/only-export-components -- dev harness exports a mount helper */
// Dev-only throwaway harness (loaded via ?harness=1). Cycles images + every procedural kind
// through all three transitions with a periodic ghost overlay, all under the film post-FX.
// Not part of the production bundle path.

import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { Compositor } from '../render/Compositor';
import { PostFX } from '../render/postfx';
import { getProceduralTexture } from '../render/procedural';
import { TRANSITION_NAMES } from '../render/transitions';
import type { ProceduralKind } from '../manifest/types';

const KINDS: ProceduralKind[] = [
  'leader',
  'fog',
  'stars',
  'iris',
  'ripple',
  'static',
  'horizon',
  'orbs',
  'filmrun',
];

const IMAGES = [
  'https://commons.wikimedia.org/wiki/Special:FilePath/The_Great_Wave_off_Kanagawa.jpg',
  'https://commons.wikimedia.org/wiki/Special:FilePath/Vincent_van_Gogh_-_The_Starry_Night_-_Google_Art_Project.jpg',
  'https://example.invalid/this-will-fail.jpg', // forces the procedural fallback path
];

function HarnessApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState('starting…');
  const [reduce, setReduce] = useState(false);
  const postRef = useRef<PostFX | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const comp = new Compositor();
    comp.init(canvas);
    const post = new PostFX(comp);
    postRef.current = post;

    const procs = KINDS.map((k) => ({ kind: k, src: getProceduralTexture(k, 'harness') }));
    comp.onFrame = (_dt, elapsed) => {
      for (const p of procs) p.src.update(elapsed);
    };

    let i = 0;
    let ti = 0;
    let cancelled = false;

    const step = async () => {
      if (cancelled) return;
      const transition = TRANSITION_NAMES[ti % TRANSITION_NAMES.length];
      ti++;
      // alternate image and procedural beats
      if (i % 2 === 0) {
        const url = IMAGES[(i / 2) % IMAGES.length | 0];
        const res = await comp.showImage(url);
        if (res.ok) {
          comp.crossfadeTo(res.texture, transition, 1200);
          setInfo(`image via ${transition}`);
        } else {
          const fall = procs[(i % procs.length)];
          comp.crossfadeTo(fall.src.texture, transition, 1200);
          setInfo(`image FAILED (${res.reason}) -> procedural ${fall.kind} (no black frame)`);
        }
      } else {
        const p = procs[i % procs.length];
        comp.crossfadeTo(p.src.texture, transition, 1200);
        setInfo(`procedural ${p.kind} via ${transition} | passes=${post.passCount}`);
      }
      // occasional ghost
      if (i % 3 === 0) {
        const g = procs[(i + 2) % procs.length];
        comp.setGhost(g.src.texture, 0.4);
      } else {
        comp.setGhost(null, 0);
      }
      i++;
    };

    comp.start();
    step();
    const id = setInterval(step, 2200);

    const onResize = () => comp.setSize(canvas.clientWidth, canvas.clientHeight);
    window.addEventListener('resize', onResize);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('resize', onResize);
      for (const p of procs) p.src.dispose();
      post.dispose();
      comp.dispose();
    };
  }, []);

  return (
    <div className="relative h-full w-full bg-ink">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="absolute left-3 top-3 space-y-2 font-mono text-xs text-lamp">
        <div className="rounded bg-black/50 px-2 py-1">{info}</div>
        <button
          className="rounded border border-amber px-2 py-1 text-amber"
          onClick={() => {
            const next = !reduce;
            setReduce(next);
            postRef.current?.setIntensity(next);
          }}
        >
          prefers-reduced-motion: {reduce ? 'ON (calmed)' : 'off'}
        </button>
      </div>
    </div>
  );
}

export function mountHarness(el: HTMLElement): void {
  createRoot(el).render(<HarnessApp />);
}

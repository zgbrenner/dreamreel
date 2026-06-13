// app/src/ui/ProjectorPanel.tsx
import { useState, useEffect } from 'react';
import { useStore } from '../state/store';

function surrealityLabel(v: number): string {
  if (v < 0.15) return 'wide awake';
  if (v < 0.35) return 'drowsy';
  if (v < 0.6) return 'dreaming';
  if (v < 0.82) return 'lucid delirium';
  return 'delirium';
}

/** The projector control panel. Every control dispatches a store action; no engine access. */
export function ProjectorPanel() {
  const playing = useStore((s) => s.playing);
  const surreality = useStore((s) => s.surreality);
  const tempoMul = useStore((s) => s.tempoMul);
  const seed = useStore((s) => s.seed);
  const soundOn = useStore((s) => s.soundOn);
  const archiveOn = useStore((s) => s.archiveOn);

  const togglePlay = useStore((s) => s.togglePlay);
  const setSurreality = useStore((s) => s.setSurreality);
  const setTempo = useStore((s) => s.setTempo);
  const reseed = useStore((s) => s.reseed);
  const setSound = useStore((s) => s.setSound);
  const setArchive = useStore((s) => s.setArchive);

  const [seedDraft, setSeedDraft] = useState(seed);
  useEffect(() => setSeedDraft(seed), [seed]);

  return (
    <aside
      aria-label="Projector controls"
      className="pointer-events-auto absolute bottom-0 left-1/2 z-30 w-full max-w-3xl -translate-x-1/2 border-t border-amber/20 bg-ink/80 px-4 py-3 backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          onClick={togglePlay}
          aria-pressed={playing}
          className="rounded border border-amber px-4 py-1.5 font-mono text-xs uppercase tracking-widest text-lamp transition-colors hover:bg-amber/15"
        >
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>

        <label className="flex min-w-[180px] flex-1 flex-col gap-1 font-mono text-[10px] uppercase tracking-widest text-amber/80">
          <span>
            Surreality — <span className="text-lamp">{surrealityLabel(surreality)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={surreality}
            onChange={(e) => setSurreality(parseFloat(e.target.value))}
            className="dr-range"
            aria-label="Surreality"
          />
        </label>

        <label className="flex min-w-[140px] flex-col gap-1 font-mono text-[10px] uppercase tracking-widest text-amber/80">
          <span>
            Tempo — <span className="text-lamp">{tempoMul.toFixed(2)}×</span>
          </span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={tempoMul}
            onChange={(e) => setTempo(parseFloat(e.target.value))}
            className="dr-range"
            aria-label="Tempo"
          />
        </label>

        <button
          onClick={() => reseed()}
          className="rounded border border-bone/30 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-bone transition-colors hover:bg-bone/10"
        >
          New dream
        </button>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reseed(seedDraft);
          }}
        >
          <label className="font-mono text-[10px] uppercase tracking-widest text-amber/80" htmlFor="seed">
            Seed
          </label>
          <input
            id="seed"
            value={seedDraft}
            onChange={(e) => setSeedDraft(e.target.value)}
            spellCheck={false}
            className="w-28 rounded border border-bone/20 bg-black/40 px-2 py-1 font-mono text-xs text-lamp"
          />
        </form>

        <button
          onClick={() => setSound(!soundOn)}
          aria-pressed={soundOn}
          className="rounded border border-bone/30 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-bone transition-colors hover:bg-bone/10"
        >
          {soundOn ? '♪ Sound' : '✕ Muted'}
        </button>

        <button
          onClick={() => setArchive(!archiveOn)}
          aria-pressed={archiveOn}
          title="Include networked public-domain media, or play from procedural sources only"
          className="rounded border border-bone/30 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-bone transition-colors hover:bg-bone/10"
        >
          {archiveOn ? '⊕ Archive feed' : '⊘ Procedural only'}
        </button>
      </div>
    </aside>
  );
}

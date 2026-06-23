// app/src/ui/ProjectorPanel.tsx
import { useStore } from '../state/store';

export interface ProjectorPanelProps {
  /** Whether the control drawer is expanded. */
  open: boolean;
  /** Toggle the drawer open/closed. */
  onToggle(): void;
}

/**
 * The projector control panel. The viewer can only summon a NEW dream — never tune or edit the
 * one they're given. So there are no dream-shaping controls (no surreality, tempo, archive, or
 * seed entry): just play/pause, "New dream" (a fresh seed), and a sound on/off output toggle.
 * Every control dispatches a store action; no engine access.
 */
export function ProjectorPanel({ open, onToggle }: ProjectorPanelProps) {
  const playing = useStore((s) => s.playing);
  const soundOn = useStore((s) => s.soundOn);

  const togglePlay = useStore((s) => s.togglePlay);
  const reseed = useStore((s) => s.reseed);
  const setSound = useStore((s) => s.setSound);

  const buttonClass =
    'rounded border px-3 py-2 font-mono text-xs uppercase tracking-widest transition-colors';

  return (
    <aside
      aria-label="Projector controls"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center"
    >
      {/* Tab handle: always reachable, hides the drawer so the gate stays immersive. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="projector-drawer"
        className="pointer-events-auto rounded-t border border-b-0 border-amber/20 bg-ink/80 px-4 py-1.5 font-mono text-[10px] uppercase tracking-widest text-amber/80 backdrop-blur-sm transition-colors hover:text-lamp"
      >
        {open ? '▾ Hide controls' : '▴ Show controls'}
      </button>

      {open && (
        <div
          id="projector-drawer"
          className="dr-panel pointer-events-auto max-h-[65vh] w-full max-w-3xl overflow-y-auto overscroll-contain border-t border-amber/20 bg-ink/80 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6">
            <button
              onClick={togglePlay}
              aria-pressed={playing}
              className={`${buttonClass} border-amber text-lamp hover:bg-amber/15`}
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>

            <button
              onClick={() => reseed()}
              className={`${buttonClass} border-bone/30 text-bone hover:bg-bone/10`}
            >
              New dream
            </button>

            <button
              onClick={() => setSound(!soundOn)}
              aria-pressed={soundOn}
              className={`${buttonClass} border-bone/30 text-bone hover:bg-bone/10`}
            >
              {soundOn ? '♪ Sound' : '✕ Muted'}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

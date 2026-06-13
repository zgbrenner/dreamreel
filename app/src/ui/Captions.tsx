// app/src/ui/Captions.tsx
import { useStore } from '../state/store';

/**
 * Archival caption strip: Courier Prime metadata (reel label, source, license) plus the
 * current drifting line as an EB Garamond italic whisper. When an asset's license starts
 * with CC-BY the attribution is rendered here — this is mandatory.
 */
export function Captions() {
  const caption = useStore((s) => s.caption);
  const isCcBy = (caption.license ?? '').toUpperCase().startsWith('CC-BY');

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-6 pb-24 sm:pb-20">
      {caption.whisper && (
        <p
          key={caption.whisper}
          className="dr-whisper max-w-3xl text-center font-drift text-xl italic text-bone/90 text-shadow-glow sm:text-2xl"
        >
          {caption.whisper}
        </p>
      )}
      <div className="flex max-w-3xl flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-[11px] uppercase tracking-wide text-amber/80">
        <span className="text-lamp">{caption.reel}</span>
        {caption.source && <span aria-hidden>·</span>}
        {caption.source && <span>{caption.source}</span>}
        {caption.license && <span aria-hidden>·</span>}
        {caption.license && <span>{caption.license}</span>}
      </div>
      {isCcBy && caption.attribution && (
        <p className="max-w-3xl text-center font-mono text-[10px] text-bone/60">
          {caption.attributionUrl ? (
            <a
              className="pointer-events-auto underline decoration-dotted"
              href={caption.attributionUrl}
              target="_blank"
              rel="noreferrer"
            >
              {caption.attribution}
            </a>
          ) : (
            caption.attribution
          )}
        </p>
      )}
    </div>
  );
}

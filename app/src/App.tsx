import { useEffect, useState } from 'react';
import { loadManifest, ManifestError } from './manifest/loader';
import type { Manifest } from './manifest/types';
import { useStore } from './state/store';
import { Gate } from './ui/Gate';
import { ProjectorPanel } from './ui/ProjectorPanel';
import { Captions } from './ui/Captions';

const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || '/manifest.seed.json';

const PANEL_PREF_KEY = 'dreamreel.panelOpen';

function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(readPanelPref);
  const togglePlay = useStore((s) => s.togglePlay);

  // Remember the control-drawer preference (a non-essential UI pref, so localStorage is allowed).
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_PREF_KEY, panelOpen ? '1' : '0');
    } catch {
      /* storage unavailable — ignore */
    }
  }, [panelOpen]);

  useEffect(() => {
    let cancelled = false;
    loadManifest(MANIFEST_URL)
      .then((m) => !cancelled && setManifest(m))
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fall back to the bundled seed manifest if a remote manifest URL fails.
        if (MANIFEST_URL !== '/manifest.seed.json') {
          loadManifest('/manifest.seed.json')
            .then((m) => !cancelled && setManifest(m))
            .catch((e2: unknown) =>
              setError(e2 instanceof ManifestError ? e2.message : String(e2)),
            );
        } else {
          setError(e instanceof ManifestError ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Space toggles play globally (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink p-8">
        <pre className="max-w-2xl whitespace-pre-wrap font-mono text-sm text-amber">
          Failed to load DREAMREEL:{'\n'}
          {error}
        </pre>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink">
        <p className="animate-flicker font-mono text-xs uppercase tracking-[0.4em] text-sepia">
          threading the reel…
        </p>
      </div>
    );
  }

  return (
    <main className="relative h-full w-full overflow-hidden bg-ink">
      <Gate manifest={manifest} />
      <Captions panelOpen={panelOpen} />
      <ProjectorPanel open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} />
    </main>
  );
}

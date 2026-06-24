import { useEffect, useState } from 'react';
import { loadManifest, ManifestError } from './manifest/loader';
import type { Manifest } from './manifest/types';
import { useStore } from './state/store';
import { Gate } from './ui/Gate';
import { ProjectorPanel } from './ui/ProjectorPanel';
import { Captions } from './ui/Captions';

// The bundled 26-asset seed manifest is a dev placeholder whose external hotlinks are flaky; the
// real corpus (326 media assets) lives on R2. Production/preview BUILDS default to the R2 manifest
// so they never silently fall back to the procedural-heavy seed when the Pages env var is missing
// on a given deployment; local `npm run dev` defaults to the fast, offline seed. `VITE_MANIFEST_URL`
// overrides either, and a failed remote load still falls back to the bundled seed below.
const R2_MANIFEST_URL = 'https://pub-0f361adf4c4d425198bd06d2d9ab5194.r2.dev/manifest/latest.json';
const SEED_MANIFEST_URL = '/manifest.seed.json';
const DEFAULT_MANIFEST_URL = import.meta.env.PROD ? R2_MANIFEST_URL : SEED_MANIFEST_URL;
const MANIFEST_URL = import.meta.env.VITE_MANIFEST_URL || DEFAULT_MANIFEST_URL;

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
        if (MANIFEST_URL !== SEED_MANIFEST_URL) {
          loadManifest(SEED_MANIFEST_URL)
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

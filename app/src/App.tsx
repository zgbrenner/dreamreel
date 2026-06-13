import { useEffect, useState } from 'react';
import { loadManifest, ManifestError } from './manifest/loader';
import type { Manifest } from './manifest/types';

// Placeholder shell for Phase 1 prompt 1. Replaced by the real Gate/ProjectorPanel UI in
// later prompts; kept loading the seed manifest so the data contract is exercised early.
export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadManifest('/manifest.seed.json')
      .then(setManifest)
      .catch((e: unknown) => setError(e instanceof ManifestError ? e.message : String(e)));
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center bg-ink text-bone">
      {error ? (
        <pre className="max-w-2xl whitespace-pre-wrap font-mono text-sm text-amber">{error}</pre>
      ) : manifest ? (
        <p className="font-title uppercase tracking-intertitle text-lamp">
          manifest loaded: {manifest.assets.length} assets
        </p>
      ) : (
        <p className="font-mono text-sm text-sepia">loading…</p>
      )}
    </div>
  );
}

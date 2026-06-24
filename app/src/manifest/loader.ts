// app/src/manifest/loader.ts
import type { Manifest } from './types';
import { manifestSchema } from './schema';
import { migrateManifest } from './migrate';

export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Fetch and validate a manifest. Throws a clear ManifestError on network failure or any
 * schema mismatch (with the zod issue list folded into the message).
 */
export async function loadManifest(url: string): Promise<Manifest> {
  let raw: unknown;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) {
      throw new ManifestError(`manifest fetch failed: ${res.status} ${res.statusText} (${url})`);
    }
    raw = await res.json();
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    throw new ManifestError(`could not load manifest from ${url}`, err);
  }
  return parseManifest(raw, url);
}

/** Validate an already-parsed value. Exposed so tests can exercise the validator directly. */
export function parseManifest(raw: unknown, source = '<inline>'): Manifest {
  // Forward-migrate legacy manifests (e.g. pre-12-axis production corpora) so they validate
  // instead of being silently rejected — a rejection drops the app back to the seed manifest.
  const result = manifestSchema.safeParse(migrateManifest(raw));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ManifestError(`invalid manifest (${source}):\n${issues}`);
  }
  return result.data as Manifest;
}

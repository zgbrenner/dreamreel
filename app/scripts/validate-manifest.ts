// Validate a manifest JSON file against the app's zod loader. Used by CI to prove the
// pipeline output conforms to the runtime contract. Usage: tsx scripts/validate-manifest.ts <path>
import { readFileSync } from 'node:fs';
import { parseManifest } from '../src/manifest/loader';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx scripts/validate-manifest.ts <manifest.json>');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(path, 'utf8'));
try {
  const m = parseManifest(raw);
  const norm = (a: { embedding: number[] }) =>
    Math.sqrt(a.embedding.reduce((s: number, x: number) => s + x * x, 0));
  const offenders = [...m.assets, ...m.texts].filter((a) => Math.abs(norm(a) - 1) > 1e-3);
  if (offenders.length) {
    console.error(`✖ ${offenders.length} embeddings are not L2-normalized`);
    process.exit(1);
  }
  console.log(`✓ VALID: ${m.assets.length} assets, ${m.texts.length} texts, dim ${m.embeddingDim}`);
} catch (e) {
  console.error('✖ INVALID manifest:\n' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

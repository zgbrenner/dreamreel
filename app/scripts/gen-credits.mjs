// Generate a credits/attribution page from a manifest. Every CC-BY source is listed (the
// license policy requires attribution to be discoverable), alongside a per-source summary.
// Usage: node scripts/gen-credits.mjs [manifestPath] [outPath]
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = process.argv[2] || 'public/manifest.seed.json';
const outPath = process.argv[3] || '../CREDITS.md';

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const all = [...(m.assets ?? []), ...(m.texts ?? [])];

const bySource = new Map();
const ccby = [];
for (const a of all) {
  const key = a.source || 'unknown';
  const entry = bySource.get(key) ?? { count: 0, licenses: new Set() };
  entry.count++;
  entry.licenses.add(a.license);
  bySource.set(key, entry);
  if (String(a.license).toUpperCase().startsWith('CC-BY')) {
    ccby.push(a);
  }
}

let out = `# DREAMREEL — Credits & Attributions\n\n`;
out += `Generated from \`${manifestPath}\` (manifest version ${m.version}). DREAMREEL ships only\n`;
out += `public-domain, CC0, and CC-BY media; every CC-BY asset's attribution is rendered on screen\n`;
out += `and listed below.\n\n`;

out += `## Sources\n\n| Source | Assets | Licenses |\n| --- | --: | --- |\n`;
for (const [source, info] of [...bySource].sort((a, b) => b[1].count - a[1].count)) {
  out += `| ${source} | ${info.count} | ${[...info.licenses].join(', ')} |\n`;
}

out += `\n## CC-BY attributions (${ccby.length})\n\n`;
if (ccby.length === 0) {
  out += `_No CC-BY assets in this manifest — all media is public domain or CC0._\n`;
} else {
  for (const a of ccby) {
    const link = a.attributionUrl ? ` — <${a.attributionUrl}>` : '';
    out += `- **${a.id}** (${a.license}): ${a.attribution ?? 'attribution required'}${link}\n`;
  }
}

out += `\n## Software\n\n`;
out += `three.js (MIT), pmndrs/postprocessing (Zlib), Tone.js (MIT), Zustand (MIT), zod (MIT),\n`;
out += `React (MIT), and SIL Open Font License fonts (Bodoni Moda, EB Garamond, Courier Prime).\n`;
out += `Transition shaders follow the gl-transitions (MIT) spec. See NOTICE.\n`;

writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${all.length} assets across ${bySource.size} sources, ${ccby.length} CC-BY`);

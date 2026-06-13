// Generates app/public/manifest.seed.json: a small, schema-valid dev stub.
// Embeddings are real 8-dim vectors, L2-normalized; mood values are genuine projections
// of each embedding onto the six mood axes (squashed to 0..1), so the Dreamwalker behaves
// against the stub the same way it will against the real corpus.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIM = 8;
const MOOD_AXES = ['melancholy', 'uncanny', 'nostalgic', 'ominous', 'tender', 'mechanical'];

function norm(v) {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Six interpretable semantic axes for the 8-dim toy space:
//  [sea, machinery, faces, ruins, cosmos, botanical, light, decay]
// Mood axis vectors are hand-placed contrasts in that space (then normalized).
const moodAxes = {
  melancholy: norm([0.3, -0.2, 0.4, 0.6, 0.1, -0.1, -0.5, 0.7]),
  uncanny: norm([0.1, 0.3, 0.6, 0.2, 0.4, -0.3, -0.2, 0.5]),
  nostalgic: norm([0.2, -0.3, 0.5, 0.3, 0.0, 0.3, 0.4, 0.6]),
  ominous: norm([0.4, 0.2, -0.1, 0.7, 0.3, -0.4, -0.6, 0.5]),
  tender: norm([-0.1, -0.5, 0.6, -0.2, 0.1, 0.6, 0.7, -0.2]),
  mechanical: norm([-0.2, 0.9, -0.2, 0.1, 0.0, -0.4, 0.2, -0.1]),
};

function moodFor(embedding) {
  const out = {};
  for (const axis of MOOD_AXES) out[axis] = +sigmoid(2.2 * dot(embedding, moodAxes[axis])).toFixed(3);
  return out;
}

// embedding tuned to its semantic content, then normalized.
function asset(o) {
  const embedding = norm(o.e);
  return {
    id: o.id,
    type: o.type,
    ...(o.src ? { src: o.src } : {}),
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.text ? { text: o.text } : {}),
    embedding,
    mood: moodFor(embedding),
    tags: o.tags,
    dwellBase: o.dwellBase,
    ...(o.grade ? { grade: o.grade } : {}),
    source: o.source,
    license: o.license,
    ...(o.attribution ? { attribution: o.attribution } : {}),
    ...(o.attributionUrl ? { attributionUrl: o.attributionUrl } : {}),
  };
}

const fp = (name) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}`;

// --- Procedural assets: one per ProceduralKind ---
const procedural = [
  ['leader', [0, 0.6, 0, 0, 0, 0, 0.7, 0.4], ['countdown', 'leader'], 4],
  ['fog', [0.4, 0, 0, 0.3, 0.1, 0.2, 0.2, 0.6], ['fog', 'haze'], 7],
  ['stars', [0.1, 0, 0, 0, 0.9, 0, 0.4, 0.1], ['cosmos', 'night'], 8],
  ['iris', [0, 0.3, 0.2, 0, 0, 0, 0.8, 0.3], ['optical', 'iris'], 5],
  ['ripple', [0.8, 0, 0, 0, 0.1, 0.2, 0.3, 0.2], ['water', 'sea'], 6],
  ['static', [0, 0.7, 0, 0.1, 0, 0, 0.1, 0.7], ['noise', 'tv'], 4],
  ['horizon', [0.5, 0, 0, 0.2, 0.3, 0.3, 0.5, 0.3], ['landscape', 'horizon'], 7],
  ['orbs', [0, 0.2, 0.1, 0, 0.4, 0.3, 0.7, 0.2], ['orbs', 'glow'], 6],
  ['filmrun', [0, 0.5, 0, 0.2, 0, 0, 0.3, 0.8], ['film', 'leader', 'decay'], 4],
].map(([kind, e, tags, dwellBase]) =>
  asset({
    id: `proc-${kind}`,
    type: 'procedural',
    kind,
    e,
    tags,
    dwellBase,
    source: 'DREAMREEL / procedural',
    license: 'CC0',
  }),
);

// --- Image assets: famous public-domain artworks via Wikimedia Special:FilePath ---
const images = [
  asset({
    id: 'img-great-wave',
    type: 'image',
    src: fp('The_Great_Wave_off_Kanagawa.jpg'),
    e: [0.95, 0, 0, 0.05, 0.1, 0.1, 0.3, 0.2],
    tags: ['sea', 'wave', 'ukiyo-e', 'storm'],
    dwellBase: 6,
    grade: 'sepia 0.35',
    source: 'Wikimedia Commons / Hokusai',
    license: 'PD',
  }),
  asset({
    id: 'img-starry-night',
    type: 'image',
    src: fp('Vincent_van_Gogh_-_The_Starry_Night_-_Google_Art_Project.jpg'),
    e: [0.1, 0, 0, 0.1, 0.9, 0.2, 0.6, 0.2],
    tags: ['cosmos', 'night', 'sky', 'stars'],
    dwellBase: 7,
    grade: 'sepia 0.25',
    source: 'Wikimedia Commons / van Gogh',
    license: 'PD',
  }),
  asset({
    id: 'img-wanderer-fog',
    type: 'image',
    src: fp('Caspar_David_Friedrich_-_Wanderer_above_the_Sea_of_Fog.jpeg'),
    e: [0.4, 0, 0.2, 0.4, 0.1, 0.2, 0.2, 0.5],
    tags: ['fog', 'figure', 'mountain', 'romantic'],
    dwellBase: 7,
    grade: 'sepia 0.4',
    source: 'Wikimedia Commons / C.D. Friedrich',
    license: 'PD',
  }),
  asset({
    id: 'img-tower-babel',
    type: 'image',
    src: fp('Pieter_Bruegel_the_Elder_-_The_Tower_of_Babel_(Vienna)_-_Google_Art_Project_-_edited.jpg'),
    e: [0.2, 0.3, 0.2, 0.85, 0.05, 0.1, 0.2, 0.4],
    tags: ['ruins', 'tower', 'architecture', 'crowd'],
    dwellBase: 6,
    grade: 'sepia 0.3',
    source: 'Wikimedia Commons / Bruegel',
    license: 'PD',
  }),
];

// --- Text pool: original surreal stream-of-consciousness lines + intertitles ---
// All original writing. Two are titlecards (intertitles); the rest drift.
const driftLines = [
  ['the clock has forgotten which hour it was promising', [0.0, 0.4, 0.2, 0.3, 0.1, 0.0, 0.3, 0.6]],
  ['a tide of photographs goes out and never returns', [0.7, 0.0, 0.3, 0.2, 0.1, 0.1, 0.2, 0.5]],
  ['somewhere a projector dreams it is a lighthouse', [0.5, 0.3, 0.1, 0.2, 0.4, 0.1, 0.7, 0.3]],
  ['the faces in the wallpaper agree to be patient', [0.0, 0.2, 0.8, 0.2, 0.1, 0.2, 0.2, 0.4]],
  ['rust learns the shape of every hand that left', [0.1, 0.5, 0.2, 0.4, 0.0, 0.1, 0.0, 0.8]],
  ['the moon is only a coin we keep losing on purpose', [0.1, 0.1, 0.1, 0.1, 0.8, 0.1, 0.5, 0.3]],
  ['gardens close their eyes when no one is counting', [0.0, 0.0, 0.3, 0.2, 0.1, 0.9, 0.5, 0.2]],
  ['machines hum the lullaby they were never taught', [0.0, 0.9, 0.1, 0.1, 0.1, 0.0, 0.2, 0.3]],
  ['the sea keeps a museum of everything it swallowed', [0.9, 0.0, 0.2, 0.3, 0.1, 0.1, 0.1, 0.4]],
  ['a door opens onto the inside of another morning', [0.1, 0.2, 0.3, 0.2, 0.2, 0.3, 0.6, 0.3]],
];

const titleCards = [
  ['AND THEN THE LIGHT REMEMBERED US', [0.1, 0.2, 0.3, 0.1, 0.3, 0.2, 0.9, 0.2]],
  ['A REEL WITH NO BEGINNING', [0.2, 0.4, 0.1, 0.4, 0.1, 0.0, 0.3, 0.6]],
];

const texts = [
  ...driftLines.map(([text, e], i) =>
    asset({
      id: `txt-drift-${i}`,
      type: 'titlecard', // text pool entries carry text; type kept simple for stub
      text,
      e,
      tags: ['drift', 'whisper'],
      dwellBase: 4,
      source: 'DREAMREEL / original',
      license: 'CC0',
    }),
  ),
  ...titleCards.map(([text, e], i) =>
    asset({
      id: `txt-card-${i}`,
      type: 'titlecard',
      text,
      e,
      tags: ['intertitle', 'card'],
      dwellBase: 5,
      source: 'DREAMREEL / original',
      license: 'CC0',
    }),
  ),
];

const manifest = {
  version: '0.1.0-seed',
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  embeddingDim: DIM,
  moodAxes,
  assets: [...procedural, ...images],
  texts,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = `${__dirname}/../public/manifest.seed.json`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `wrote ${outPath}: ${manifest.assets.length} assets, ${manifest.texts.length} texts, dim ${DIM}`,
);

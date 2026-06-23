// app/src/manifest/types.ts
// Frozen data contract. Field names must not change — the pipeline emits these exactly
// and the runtime builds against them.

// The emotional taxonomy. Mood is a CONTINUOUS, BLENDABLE vector over ALL of these axes
// (0..1 each) — never reduced to a single dominant label — so the runtime can express
// combinations (tender+loss = bittersweet, joy+uncanny = manic). The first six are the
// original CLIP mood axes; love/loss/joy/fear/absurdity/strange widen the emotional range.
// Order is frozen and must match pipeline/embed/mood_axes.py MOOD_AXES.
export type MoodAxis =
  | 'melancholy'
  | 'uncanny'
  | 'nostalgic'
  | 'ominous'
  | 'tender'
  | 'mechanical'
  | 'love'
  | 'loss'
  | 'joy'
  | 'fear'
  | 'absurdity'
  | 'strange';

export const MOOD_AXES: MoodAxis[] = [
  'melancholy',
  'uncanny',
  'nostalgic',
  'ominous',
  'tender',
  'mechanical',
  'love',
  'loss',
  'joy',
  'fear',
  'absurdity',
  'strange',
];

export type AudioKind = 'music' | 'voice' | 'foley';

export interface AudioAsset {
  id: string;
  kind: AudioKind;
  src: string;
  embedding: number[]; // L2-normalized CLAP embedding
  mood: Record<MoodAxis, number>; // 0..1 per axis
  tags: string[];
  durationSec: number;
  loopable: boolean;
  dwellBase: number;
  source: string;
  license: string;
  attribution?: string;
  attributionUrl?: string;
}

export type AssetType = 'image' | 'video' | 'procedural' | 'titlecard';

export type ProceduralKind =
  | 'fog'
  | 'stars'
  | 'iris'
  | 'ripple'
  | 'static'
  | 'horizon'
  | 'orbs'
  | 'filmrun'
  | 'leader';

export interface Asset {
  id: string;
  type: AssetType;
  src?: string; // R2 URL for image/video
  kind?: ProceduralKind; // for type === 'procedural'
  text?: string; // for type === 'titlecard'
  embedding: number[]; // L2-normalized CLIP embedding; procedural/titlecard get a synthetic one
  mood: Record<MoodAxis, number>; // 0..1 per axis (projection of embedding onto axis vectors)
  tags: string[];
  dwellBase: number; // seconds the asset wants to linger
  grade?: string; // optional CSS/shader color-grade hint, e.g. "sepia 0.5"
  source: string; // e.g. "Openverse / Flickr Commons"
  license: string; // "CC0" | "PD" | "CC-BY-4.0" | ...
  attribution?: string; // required text when license starts with "CC-BY"
  attributionUrl?: string;
  claptext?: number[]; // optional CLAP embedding bridge for visual assets
}

export interface Manifest {
  version: string;
  createdAt: string;
  embeddingDim: number; // e.g. 512
  moodAxes: Record<MoodAxis, number[]>; // axis vectors in embedding space, for projection
  assets: Asset[]; // visual pool
  texts: Asset[]; // text pool (titlecard + drifting lines), each with an embedding
  audioEmbeddingDim: number; // e.g. 512 (CLAP dimension)
  audio: AudioAsset[]; // audio pool
}

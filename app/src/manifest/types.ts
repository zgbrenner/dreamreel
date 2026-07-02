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
  // Optional offline rhythmic analysis (librosa, ISC; pipeline/audio/tempo.py). Absent on
  // legacy manifests — the runtime degrades gracefully to the un-quantized behaviour.
  bpm?: number; // detected tempo in beats/min; drives bar-quantized audio dwell
  energy?: number; // normalized rhythmic energy 0..1; biases selection by mood arousal
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
  // Optional offline LAION aesthetic score (~0..10) baked by pipeline/embed/aesthetic.py. Absent
  // on legacy manifests → the walk's aesthetic bias is a graceful no-op.
  aesthetic?: number;
  // Optional usable interior SHOT windows (seconds, absolute in the source film) detected offline
  // by pipeline/embed/shots.py (PySceneDetect). For type === 'video' only: the runtime plays a
  // deterministically-chosen real shot (seek + loop within [start,end]) instead of the film's
  // leader/title-card opening. Absent → the video plays from 0 as before.
  shots?: { start: number; end: number }[];
  // Optional open-set ENTITY tags (RAM++, pipeline/embed/entities.py) — the concrete things in the
  // asset (clock, staircase, bird, hands, moon…). These feed the runtime's DreamMemory so motifs
  // RECUR across a dream (dream/memory.ts). Absent → no recurrence contribution (graceful).
  entities?: string[];
  // Optional R2 URL of a grayscale DEPTH map baked offline (Depth Anything V2 Small, Apache-2.0 —
  // pipeline/embed/depth.py). Enables runtime 2.5D depth-parallax / rack-focus treatments on the
  // asset. Absent on legacy manifests → flat rendering, exactly as before (graceful).
  depthSrc?: string;
  // Optional R2 URL of a small RG-encoded optical-FLOW texture (RAFT, pipeline/embed/flow.py) for
  // motion-aware treatments (datamosh smear along real scene motion). Absent → procedural flow.
  flowSrc?: string;
  // Optional R2 URL of a motion-interpolated SLOW-MOTION variant of a video clip (ffmpeg
  // minterpolate, pipeline/embed/retime.py). The runtime deterministically prefers it on
  // tender/nostalgic low-intensity beats. Absent → the normal-speed src plays (graceful).
  slowSrc?: string;
  // Optional baked MOTION metadata (RAFT, pipeline/embed/flow.py): overall motion energy plus
  // compact in/out motion signatures (8-bin direction histogram + mean magnitude) used for
  // MOTION-MATCHED CUTS — the walk leans toward a next clip whose opening motion continues the
  // current clip's closing motion. Absent → no motion bias (graceful).
  motion?: { energy?: number; inSig?: number[]; outSig?: number[] };
}

// A segmented entity cutout (RGBA PNG on R2) — the literal pixels of a recurring motif, extracted
// offline (Grounding DINO box → SAM 2 mask, pipeline/embed/sprites.py). The runtime summons one
// when the dream strongly remembers its entity, so the actual fragment drifts back into a later
// scene (dream/memory.ts + render/SpriteField.ts). License carries from the source asset.
export interface EntitySprite {
  id: string;
  entity: string; // the RAM++ entity this cutout depicts (matches Asset.entities)
  src: string; // R2 URL of the RGBA PNG cutout (a sprite SHEET when frames > 1)
  aspect: number; // width / height of a single frame, so the runtime quad keeps proportions
  // Optional animation (SAM 2 video tracking): a frames>1 sprite is a grid sprite sheet that the
  // runtime cycles, so the segmented figure MOVES as it recurs. `cols` is the grid width; rows are
  // ceil(frames / cols). Absent / frames<=1 → a static cutout.
  frames?: number;
  cols?: number;
  fps?: number; // cycle rate (default ~10)
  source: string;
  license: string;
  attribution?: string;
  attributionUrl?: string;
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
  // Optional pool of segmented entity cutouts for literal motif recurrence (memory Phase 2).
  entitySprites?: EntitySprite[];
}

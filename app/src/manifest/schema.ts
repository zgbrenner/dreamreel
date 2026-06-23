// app/src/manifest/schema.ts
// Runtime validation of the manifest contract via zod. Kept separate from types.ts so the
// pure type module stays dependency-free and tree-shakeable.

import { z } from 'zod';
import { MOOD_AXES } from './types';

const audioKindSchema = z.enum(['music', 'voice', 'foley']);

const moodRecord = z.object(
  Object.fromEntries(MOOD_AXES.map((a) => [a, z.number()])) as Record<
    (typeof MOOD_AXES)[number],
    z.ZodNumber
  >,
);

export const audioAssetSchema = z.object({
  id: z.string().min(1),
  kind: audioKindSchema,
  src: z.string().url(),
  embedding: z.array(z.number()).min(1),
  mood: moodRecord,
  tags: z.array(z.string()),
  durationSec: z.number().positive(),
  loopable: z.boolean(),
  dwellBase: z.number().positive(),
  source: z.string().min(1),
  license: z.string().min(1),
  attribution: z.string().optional(),
  attributionUrl: z.string().optional(),
});

const assetTypeSchema = z.enum(['image', 'video', 'procedural', 'titlecard']);
const proceduralKindSchema = z.enum([
  'fog',
  'stars',
  'iris',
  'ripple',
  'static',
  'horizon',
  'orbs',
  'filmrun',
  'leader',
]);

export const assetSchema = z.object({
  id: z.string().min(1),
  type: assetTypeSchema,
  src: z.string().url().optional(),
  kind: proceduralKindSchema.optional(),
  text: z.string().optional(),
  embedding: z.array(z.number()).min(1),
  mood: moodRecord,
  tags: z.array(z.string()),
  dwellBase: z.number().positive(),
  grade: z.string().optional(),
  source: z.string().min(1),
  license: z.string().min(1),
  attribution: z.string().optional(),
  attributionUrl: z.string().optional(),
  claptext: z.array(z.number()).optional(),
});

export const manifestSchema = z
  .object({
    version: z.string().min(1),
    createdAt: z.string().min(1),
    embeddingDim: z.number().int().positive(),
    moodAxes: z.object(
      Object.fromEntries(MOOD_AXES.map((a) => [a, z.array(z.number())])) as Record<
        (typeof MOOD_AXES)[number],
        z.ZodArray<z.ZodNumber>
      >,
    ),
    assets: z.array(assetSchema),
    texts: z.array(assetSchema),
    audioEmbeddingDim: z.number().int().positive(),
    audio: z.array(audioAssetSchema),
  })
  .superRefine((m, ctx) => {
    // Dimensional consistency: every embedding and axis must match embeddingDim.
    const check = (arr: number[], where: string) => {
      if (arr.length !== m.embeddingDim) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${where} length ${arr.length} != embeddingDim ${m.embeddingDim}`,
        });
      }
    };
    for (const a of m.assets) check(a.embedding, `asset ${a.id} embedding`);
    for (const t of m.texts) check(t.embedding, `text ${t.id} embedding`);
    for (const axis of MOOD_AXES) check(m.moodAxes[axis], `moodAxis ${axis}`);

    // CC-BY assets must carry attribution (hard license rule, surfaced early).
    for (const a of [...m.assets, ...m.texts]) {
      if (a.license.toUpperCase().startsWith('CC-BY') && !a.attribution) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `asset ${a.id} is ${a.license} but has no attribution`,
        });
      }
    }

    // Audio: CLAP-dim consistency + CC-BY attribution rule.
    for (const a of m.audio) {
      if (a.embedding.length !== m.audioEmbeddingDim) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `audio ${a.id} embedding length ${a.embedding.length} != audioEmbeddingDim ${m.audioEmbeddingDim}`,
        });
      }
      if (a.license.toUpperCase().startsWith('CC-BY') && !a.attribution) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `audio ${a.id} is ${a.license} but has no attribution`,
        });
      }
    }
  });

export type ValidatedManifest = z.infer<typeof manifestSchema>;

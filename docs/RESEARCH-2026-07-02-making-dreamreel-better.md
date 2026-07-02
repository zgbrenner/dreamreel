# Making DREAMREEL Way Better — Research Report (2026-07-02)

Deep research into open-source projects and techniques that can make DREAMREEL dramatically more
interesting, every idea filtered through the architecture's hard constraints: zero runtime
inference (offline pipeline bakes everything into the static manifest), seeded determinism,
single-verb UX, and the MIT/BSD/Apache-2.0/Zlib/ISC/CC0/PD/CC-BY-only license wall for anything
shipped. License notes below are backed by primary-source quotes gathered during research; the CI
license gate remains the final backstop before anything ships.

The unifying thesis: **DREAMREEL already bakes semantic metadata (embeddings, moods, entities,
sprites) offline and spends it at runtime. The biggest wins come from baking two more kinds of
per-asset metadata — DEPTH and MOTION — and from grounding the dream grammar in actual dream
science.** Everything else compounds on those.

---

## Tier 1 — highest impact per effort

### 1. Depth-parallax: turn every frame into a 2.5D space ("the moving painting")

The single biggest visual leap available. Bake a depth map per still (and per video shot
keyframe) offline; at runtime, a ~20-line GLSL UV-displacement gives every image dimensional
drift — the existing pointer/tilt presentation shimmer stops being a flat pan and becomes
*standing inside the picture*. Real dreams have depth; flat archival footage does not.

- **Depth Anything V2 — Small** (code Apache-2.0; **Small checkpoint Apache-2.0** — the
  Base/Large/Giant weights are CC-BY-NC-4.0 and must be avoided; primary-source: repo README
  license section, confirmed in issue #162). 24.8M params, runs in HF Transformers — slots
  straight into the existing `pipeline/embed/` PyTorch stack. Per still: one grayscale depth PNG
  (quarter-res is plenty) uploaded beside the webp.
- **Video Depth Anything — Small** (Apache-2.0 Small variant; CVPR 2025 highlight): temporally
  consistent depth for whole clips — 28.4M params, ~7.5 ms/frame on an A100, so the 40-clip corpus
  bakes in minutes. Store as a downscaled depth video (H.264 grayscale beside each clip) or a
  per-shot depth atlas.
- Runtime: the fake-3D depth-displacement technique (canonical Codrops write-up; the shader is
  trivially reimplemented in the existing `TransitionMaterial`/LayerStack pipeline).
- **What depth unlocks beyond parallax** (all cheap once maps exist): depth-aware fog that sits
  *in* the scene instead of on the glass; rack-focus pulls (deeply oneiric — focus drifting from
  foreground to background is a dream-camera move); recurring entity sprites (`SpriteField`)
  passing **behind** foreground elements via depth-test against the baked map, which makes the
  memory system read as inhabiting the scene rather than floating over it.
- Manifest: `depthSrc?: string` per asset / per shot; graceful no-op on legacy manifests, like
  `shots[]` and `entities[]` before it.

### 2. Bake optical flow; cut and smear along real motion

- **RAFT** (princeton-vl, **BSD-3-Clause** — primary-source LICENSE quote confirmed; ECCV 2020,
  pretrained weights via `download_models.sh`, ready-made `demo.py` batch path). Bake a tiny
  per-shot flow summary offline: a 64×36 RG flow texture (a few KB) + scalar motion-energy per
  shot in the manifest.
- **Three runtime spends, in order of coolness:**
  1. **Real datamosh for nightmare surges.** Port the block-displacement algorithm from
     **keijiro/KinoDatamosh** (**Unlicense / public domain** — fully shippable) into a
     pmndrs/postprocessing Effect: during escalation surges, stop sampling fresh frames and
     displace the existing LayerStack **feedback buffer** (which already exists for echo-trails)
     along the *baked flow field* — the image smears along the direction things were actually
     moving. This is the signature "dream dissolving" effect, and nobody else has it because it
     needs offline flow + a feedback compositor, which DREAMREEL uniquely already has half of.
  2. **Motion-matched cuts.** Offline, compute a shot-to-shot flow-similarity matrix (closing
     motion of shot A vs opening motion of shot B); at runtime, add a bounded pre-softmax bonus
     for candidates whose opening motion continues the current clip's closing motion. Cuts become
     invisible the way dream scene-changes are — *the motion carries across the cut even though
     the world changed*. (Editors call this a match cut; dreams do it constantly.)
  3. **Cut on motion peaks**: swap timing biased toward the baked motion-energy peaks — the reel
     starts "editing like an editor" for free.

### 3. Ground the dream grammar in actual dream science

Research surfaced a small canon that reads like a spec for the Dreamwalker:

- **Bizarreness with a through-line** (Rittenhouse et al., *Consciousness & Cognition*): real
  dream discontinuities are not random — "a peripheral association in one scene becomes dominant
  in the following scene," with an **emotional theme bridging the cut**. Concrete change: replace
  the uniform-random leap target with a **leap-with-through-line** — the leap target must share
  either a *non-dominant entity* or a *secondary mood axis* with the current scene (both already
  in the manifest; zero new pipeline). Leaps keep their shock but stop feeling arbitrary — this
  is the principled fix for "clip selection makes no sense."
- **Entity match-cuts** (same machinery, non-leap beats): a small pre-softmax bonus for
  candidates sharing an entity with the current asset — dog → *different* dog in a *different*
  film. "Same thing, wrong form" is the core dream sensation, and `entities[]` makes it a
  ~10-line change to `weigh()`.
- **Hypnagogic onset** (Nielsen's microdream/oneiragogic-spectrum work): sleep-onset imagery
  starts as *fragmentary flashes* before cohering into scenes. Open every dream with a short
  seeded hypnagogia phase — 2–4 subliminal flash-frames and half-formed ghosts sliding into the
  first held scene. Research-grounded, beautiful, and it doubles as a cold-start mask while the
  first videos buffer.
- **The night gets stranger** (Martin et al., graph analysis of REM reports: dreams grow longer,
  more connected, more bizarre across the night): add a slow within-dream ramp — temperature,
  leap probability, and the filter ceiling drift upward as the dream ages, so a 3-minute watch
  and a 30-minute ambient session have genuinely different arcs.
- **False awakening** (classic dream phenomenon; fits the existing trough machinery): a rare
  seeded event where a coherence trough overshoots — the reel "wakes" into a clean, unfiltered,
  held lucid shot with the audio bed dropped to near-silence… then one wrong detail (a ghost
  layer, a reversed clip) and it dissolves back under. The single most memorable thing a viewer
  could stumble into.
- **Calibrate the mood distribution against real data**: the Hall/Van de Castle norms
  (DreamBank.net, 1,000 baseline reports) quantify real dream emotion frequencies — apprehension
  is the single most common emotion. `deriveMoodIdentity`'s 68/20/12 gentle/neutral/nightmare
  split is a design choice, not an error, but now it can be tuned *relative to documented
  reality* (e.g., "half as scary as real dreams"), and DreamBank's 20k+ reports are a mineable
  PD-adjacent corpus for dream-voice text patterns.

### 4. Corpus: the fragments that already look like dreams

- **EYE Filmmuseum "Bits & Pieces"** — hundreds of short, *unidentified* silent-film fragments
  preserved precisely because nobody knows what they're from: orphaned, contextless, frequently
  gorgeous. This is the dream-logic aesthetic in raw form, and a mirror exists on archive.org
  (`Bitspieces_201703`), so `pipeline/ingest/archive_org.py` can pull it with a one-line
  `COLLECTIONS` addition. EYE's own **Jan Bot** project (algorithmic films cut from Bits &
  Pieces) is direct artistic precedent for the seeded-walk-over-fragments idea.
- **Library of Congress National Screening Room** — hundreds of historic films (home movies,
  actualities, early cinema) with **downloadable MP4s** for PD-believed titles and a clean JSON
  API (`loc.gov`); a natural second ingester beside archive.org, reusing the size-aware
  file-picking pattern.
- **Public Domain Review film collections** — not an API, a *taste layer*: hand-curated trick
  films, early animation, scientific cinema, most pointing back at archive.org identifiers. Mine
  it for the `COLLECTIONS` list — this is how the corpus gets "artful, not generic."
- **The Great 78 Project** — ~400k digitized 78rpm sides (1880–1960) on archive.org (already the
  audio ingest source); see Tier 2 audio for what to do with them beyond straight sampling.

### 5. Widen the transition vocabulary for free

**gl-transitions/gl-transitions** (repo-level **MIT**, 123 community transitions). DREAMREEL
implements the gl-transitions spec already (~30 in-house shaders, all compile-checked in CI) —
directional warps, morphs, luma wipes, and ripples can be dropped into `render/transitions.ts`
nearly verbatim and wired into the existing 12-axis mood→family blend. Highest
impact-per-keystroke item on this list. (While in there: route **wake-mode** hero swaps through
`pickTransition` — the mood-mapped catalog currently only plays in classic mode.)

**License traps confirmed for the shader-library aisle** (stay away for shipped code):
**LYGIA** is Prosperity/Patron dual-licensed (non-commercial) despite being everywhere in
three.js tutorials; **Shadertoy** code defaults CC-BY-NC-SA. Both are inspiration-only, like
Hydra (AGPL).

### 6. A real dream-voice: 3 million lines of public-domain poetry

**aparrish/gutenberg-poetry-corpus** — 3M+ single lines of PD poetry as JSON with source-book
IDs. Pipeline: SigLIP-text-embed each candidate line, project onto the 12 mood axes, curate a
few thousand high-affinity lines into `texts[]` (the manifest already supports exactly this —
the PD-poetry ingest shipped +100 lines; this is the same lever ×30 with mood-targeted
curation). The drifting captions stop repeating and start feeling *authored by the dream*.

---

## Tier 2 — distinctive, moderate effort

### 7. Ghost music: granulated 78s

The Great 78 corpus + **librosa** (ISC, already a pipeline dep): offline, granulate and
time-stretch pre-1929 sides into long ambient pad stems — the "song heard through three rooms
and eighty years" texture — CLAP-embed and mood-tag them, and the existing `audioWalker`
surfaces era-matched ghost music under the era-matched film. No new runtime code at all; it's an
audio-corpus build variant.

### 8. Per-seed sound *architecture*, not just parameters

- **generativefm/generators** (Alex Bainter's Generative.fm — **MIT**, and built on **Tone.js**):
  50+ endless ambient pieces published as npm packages. Architecturally a sibling of the existing
  audio bed — lift its proven patterns (sparse sampled instruments, probabilistic schedulers,
  long-tail reverb chains) or whole pieces, replacing `Math.random` with the seeded PRNG and
  wiring density/brightness to the 12-axis mood.
- **Glicol** (chaosprint — **MIT**, Rust→WASM AudioWorklet, sample-accurate): lets the seed
  assemble a *different synth graph topology per dream*, not just different knob values — one
  dream's bed is bowed glass, another's is a detuned choir. This is how two seeds get genuinely
  different sonic identities.
- **Faust → WASM** (compile own DSP offline; `faust2webaudio` carries an MIT grant, and compiled
  output of your own Faust code is yours): a granular engine over the *current film clip's own
  soundtrack* — the hero clip's audio smeared into a pad in real time — ties sound to image more
  tightly than any sample pool can.
- **Ruled out by license, definitively**: Csound in the browser (Apache JS wrapper over an
  **LGPL-2.1 wasm core** — violates the no-LGPL-embedded rule) and RNBO export (proprietary
  "Max-Generated Code" license, revenue-gated — exactly the source-available category the rules
  forbid).

### 9. Pixel-sorting as a mood filter

Real-time pixel-sort approximation in a fragment shader via threshold masks + crafted vector
fields (ciphrd's GLSL write-up; reimplement from the description — the article code carries no
explicit license). Slots into `render/DreamFilter.ts` as a seventh treatment mapped to
mechanical/strange/fear, strength on the intensity heartbeat like the rest. Distinctive glitch
aesthetic several notches above the stock three.js GlitchPass.

### 10. Shareable dream artifacts — make the seed viral

The seed is already the share (`?seed=`), but nothing *shows* it. Two zero-backend artifacts:

- **Dream poster**: on demand (end of a dream, or a long-press), compose a canvas — one or two
  held frames, the dream's dominant mood axes as the palette, a poetry line, the seed set in
  Bodoni Moda — and `toBlob()` it for save/share. A beautiful, deterministic artifact of *this*
  dream.
- **Dream loop**: capture 3–4 seconds of the compositor canvas via `MediaRecorder`/WebCodecs
  (both standard browser APIs) into a small looping WebM with the seed burned into a corner.
  People share loops; loops carry seeds; seeds are the product.

### 11. A per-seed dream grammar for generated text

**galaxykate/tracery** (**Apache-2.0**) + **dariusk/corpora** (**CC0**): a compact dream-voice
grammar (rooms, weather, body parts, archaic words — corpora has the exact lists) expanded by
the seeded PRNG, so each dream owns a *recurring mutating phrase* — the text-level analogue of
the visual memory system ("the house with too many doors" returning at beat 40, slightly
wrong). Complements the poetry mining: grammar for identity, poetry for texture.

### 12. Ambient/TV mode

The Ambient Swim north star implies a lean-back mode: `?ambient=1` → Screen Wake Lock +
auto-fullscreen + UI chrome fully asleep + slightly longer dwells. Trivial to build; changes
where the app *lives* (a TV across the room) and how long sessions run. Pairs with the Tier-1
"night gets stranger" arc, which rewards long sessions.

---

## Tier 3 — worth prototyping, bigger lifts or open questions

- **Frame-interpolated slow motion** (**Practical-RIFE**, MIT including distributed models,
  maintainer-recommended v4.25): offline 2×/4× retiming of jittery 16–18fps footage into fluid
  dream-speed variants; ship *both* speeds and let mood pick (tender/nostalgic → half-speed).
  Storage doubles per treated clip — use selectively on the most-surfaced clips.
- **The color turn** (**DeOldify** — code *and* weights MIT; repo archived Oct 2024, Linux+GPU,
  so a frozen offline tool): colorize a handful of clips and stage the *Wizard-of-Oz moment* —
  deep in a gentle dream, the world quietly gains color, then loses it. Rare by design (the
  aesthetic direction favors juxtaposition over re-grading), but as a once-per-many-dreams event
  it's unforgettable.
- **Depth video for every clip**: full per-frame depth parallax on video (not just per-shot
  keyframes) — costs a parallel grayscale video per clip on R2; prototype on 5 clips first.
- **WebGPU compute path** for the feedback/datamosh stack — only once WebGL headroom actually
  runs out; not a 2026 priority.

## Suggested sequencing

1. **Now (runtime-only, no pipeline run):** entity match-cuts + leap-with-through-line;
   gl-transitions import + wake-mode transition routing; hypnagogic onset; within-dream
   bizarreness ramp; false awakening; ambient mode.
2. **Next corpus build:** Bits & Pieces + LoC ingesters; poetry mining at scale; granulated-78
   stems; depth maps for stills (Depth Anything V2 Small).
3. **Then:** RAFT flow bake → datamosh surge + motion-matched cuts; depth for video shots;
   dream poster/loop artifacts; Glicol/Faust audio experiments.

## Research caveats

Search and source-fetching completed; the adversarial verification pass was interrupted by an
infrastructure rate limit, so treat license claims as *primary-source-quoted but single-sourced*
— re-confirm each project's LICENSE file at adoption time (the CI license gate already enforces
this for anything entering `package.json`). The dream-science citations (DreamBank/Hall–Van de
Castle, Nielsen's microdream work, Rittenhouse bizarreness graphs, REM graph analysis) are
peer-reviewed literature surfaced with abstracts; read the papers before encoding numbers from
them.

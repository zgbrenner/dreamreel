# trackfx

A small, self-contained Python tool: take an input video, detect + segment + track
objects frame-by-frame, and use the masks/tracker IDs/confidence as a spatial control
signal for surreal visual effects, then write out a new video.

Built on [`roboflow/supervision`](https://github.com/roboflow/supervision) as the
post-processing/tracking/IO spine (`VideoInfo`, `get_video_frames_generator`,
`VideoSink`, `ByteTrack`, `DetectionsSmoother`) -- model-agnostic, since supervision
accepts detections from almost anything via `sv.Detections`.

Not currently wired into the rest of DreamReel (no imports from/into `app/` or
`pipeline/`) -- it's a standalone experiment that may get pulled into the product
later, hence its own `pyproject.toml`/`requirements.txt`/tests.

## Model choice & licensing

Default detector: torchvision's `maskrcnn_resnet50_fpn_v2`, COCO-pretrained. Both
torchvision's code and the pretrained weights it serves are **BSD-3-Clause**
(https://github.com/pytorch/vision/blob/main/LICENSE) -- permissive, no copyleft, safe
to ship in a commercial product. It returns per-instance segmentation masks, which is
the whole point.

**Deliberately not used:** Ultralytics YOLOv8/v11-seg. It's the obvious choice --
`sv.Detections.from_ultralytics` is supervision's flagship connector and YOLO-seg
masks are good -- but since Ultralytics' relicense, both the `ultralytics` package and
its pretrained weights are **AGPL-3.0** unless you hold a paid Enterprise license.
DreamReel's `CLAUDE.md` hard-bans AGPL from shipped code, so it's disqualified. If a
future swap wants YOLO-seg for quality/speed, budget for an Enterprise license, or
pick a different permissively-licensed segmentation model first.

There's no `sv.Detections.from_torchvision` connector in supervision (as of the
version pinned here), so `detector.py` builds `sv.Detections` directly from the raw
model output -- a normal, fully-supported pattern (`Detections` is just a dataclass of
arrays).

A `--detector fasterrcnn` option swaps in `fasterrcnn_resnet50_fpn_v2` (same
license/family, boxes only, no masks) specifically to exercise the no-mask fallback
path against a real model rather than only a mocked one.

## Effects

| name | what it does |
| --- | --- |
| `tint` | Trivial proof-of-pipeline effect: flat-tints every tracked mask in a per-tracker-ID hue. Exists to validate the IO/detect/track plumbing in isolation before trusting the real effects. |
| `ghost_trail` | Objects bloom into a fading, colorized double-exposure trail the longer ByteTrack has tracked them (a fresh detection leaves no trail; a few seconds of stable tracking ramps it to full strength). Exploits **track age** as a temporal-coherence signal. |
| `dream_gate` | Gates the treatment by mask membership: tracked objects stay crisp/anchored, everything outside their masks melts into a desaturated, temporally-smeared backdrop. Detection **confidence** feathers each mask's edge -- uncertain objects blend softer into the dissolve. |
| `glitch_resolve` | RGB-channel-split glitch inside each mask, strength = `(1 - confidence) * (1 - resolved)` where `resolved` ramps up with **track age**. A shape that "won't resolve" settles into solidity once the tracker has held it for a few seconds. |

Effects are a simple registry (`trackfx/effects/__init__.py`): each module calls
`@register("name")` on a `(frame, detections, ctx) -> frame` function. Swapping
effects is just `--effect <name>`; adding one is a new file plus a decorator.

## Usage

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# (CPU-only torch is much smaller/faster to install:)
#   pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# fast downsampled preview (640px wide, aspect preserved)
python -m trackfx input.mp4 preview.mp4 --effect ghost_trail --mode proxy

# full-resolution final render
python -m trackfx input.mp4 output.mp4 --effect dream_gate --mode full

# exercise the boxes-only fallback path with a real (non-segmentation) model
python -m trackfx input.mp4 output.mp4 --effect tint --detector fasterrcnn
```

Runs on CPU by default if no GPU is available; pass `--device cuda` to force GPU, or
leave `--device auto` (default) to pick automatically via `torch.cuda.is_available()`.

Run `python -m trackfx --help` for the full flag list (confidence threshold, tracker
sensitivity, smoother window, frame cap for quick iteration, etc).

## Handling detectors that only return boxes

`masks.MaskFallback` checks every frame: if `Detections.mask is None` but there are
detections, it logs a one-time warning and synthesizes rectangular masks from the
boxes so mask-driven effects still produce a visible (if boxier) result instead of
silently doing nothing. `--detector fasterrcnn` triggers this path for real.

## A note on `ByteTrack`'s deprecation

supervision 0.28.0 soft-deprecated `sv.ByteTrack` in favor of `ByteTrackTracker` from
a new, separate `trackers` package (with `update_with_detections()` renamed to
`update()`), targeting removal in 0.30.0. It's still fully functional as of 0.29.x --
just emits a `FutureWarning` -- and adopting a whole second tracking package wasn't
justified for this initial build, so `requirements.txt`/`pyproject.toml` pin
`supervision<0.30.0`. See the note in `pipeline.py` when it's time to migrate.

## A note on `DetectionsSmoother`

supervision's `DetectionsSmoother` docstring is explicit: *"This class is not
compatible with segmentation models"* -- it smooths `xyxy`/`confidence` across a
window, but `mask` is left as a stale passthrough from the oldest frame in that
window. Piping mask-driven rendering through its output would silently composite
misaligned, several-frames-stale masks.

So the pipeline (`pipeline.py`) calls `DetectionsSmoother` as documented (it's part of
the required tracking spine, and it does usefully stabilize box jitter and tolerate
a frame or two of detection dropout for a track), but **always renders from the raw,
unsmoothed per-frame masks** coming out of `ByteTrack`. The smoother's jitter-
stabilized boxes are exposed to effects (`EffectContext.smoothed_xyxy`) as
supplementary metadata -- `glitch_resolve` uses it to scale displacement to a
stable object size instead of flickering on box jitter.

## Tests

```bash
pip install -r requirements.txt -e ".[dev]"
pytest
```

Unit tests cover the mask fallback, proxy/full resize math, the effect registry, and
each effect's output shape/dtype plus its core behavioral claim (e.g. `ghost_trail`
actually strengthens with track age). A full pipeline round-trip test
(`test_pipeline_roundtrip.py`) exercises real supervision video IO + `ByteTrack` +
`DetectionsSmoother` end-to-end via a small synthetic video and a stub detector --
`detector.py`'s real torchvision backend isn't covered by the unit tests (downloading
~170MB of COCO weights doesn't belong in a fast test suite); it's exercised manually
via the CLI.

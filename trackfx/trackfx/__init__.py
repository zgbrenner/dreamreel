"""trackfx: tracking-driven surreal video effects for DreamReel.

Pipeline: decode (supervision video IO) -> segment+detect (torchvision) ->
track (ByteTrack) -> smooth (DetectionsSmoother) -> pluggable effect -> encode.

`track_frames` / `collect_track_masks` expose the detect+track spine on its own (no
video file, no effect) for callers that just want the tracked masks -- e.g. the
offline entity-sprite extractor in DreamReel's pipeline.
"""

# NOTE: these re-exports import supervision/torch transitively. That's fine for the
# runtime tool, but keep any pure helpers importable without them in their own modules.
from .tracking import collect_track_masks, track_frames

__version__ = "0.1.0"

__all__ = ["track_frames", "collect_track_masks", "__version__"]

"""trackfx: tracking-driven surreal video effects for DreamReel.

Pipeline: decode (supervision video IO) -> segment+detect (torchvision) ->
track (ByteTrack) -> smooth (DetectionsSmoother) -> pluggable effect -> encode.
"""

__version__ = "0.1.0"

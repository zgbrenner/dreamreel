"""Mood axes as CLIP text-embedding contrasts.

Each MoodAxis is defined as embed(positive prompts) - embed(negative prompts), normalized.
An asset's mood is the projection of its embedding onto each axis, squashed to 0..1. The
squash constant matches the app's projectMood (mood.ts) so live and baked mood agree.
"""

from __future__ import annotations

import numpy as np

from .clip_backend import Embedder, l2_normalize

# Order must match MoodAxis in app/src/manifest/types.ts.
# Mood is a CONTINUOUS, BLENDABLE vector over ALL these axes (never a single dominant label),
# so the runtime can express combinations (tender+loss = bittersweet, joy+uncanny = manic).
MOOD_AXES = [
    "melancholy",
    "uncanny",
    "nostalgic",
    "ominous",
    "tender",
    "mechanical",
    "love",
    "loss",
    "joy",
    "fear",
    "absurdity",
    "strange",
]

# Each axis is a CLIP text-embedding contrast: average several positive prompts minus several
# negatives, then L2-normalize (see build_axes). The new axes follow the same construction.
_CONTRASTS: dict[str, tuple[list[str], list[str]]] = {
    "melancholy": (
        ["melancholy", "mournful, grieving", "a sorrowful faded photograph"],
        ["cheerful", "bright and joyful", "a happy sunny scene"],
    ),
    "uncanny": (
        ["uncanny, eerie, dreamlike and strange", "an unsettling surreal image"],
        ["ordinary, mundane, familiar", "a plain everyday photo"],
    ),
    "nostalgic": (
        ["nostalgic, sepia memory, antique", "an old cherished keepsake"],
        ["modern, futuristic, brand new", "a sleek contemporary product"],
    ),
    "ominous": (
        ["ominous, foreboding, menacing darkness", "a threatening storm"],
        ["safe, calm, reassuring", "a peaceful gentle morning"],
    ),
    "tender": (
        ["tender, gentle, loving warmth", "a soft intimate moment"],
        ["harsh, cold, brutal", "a violent aggressive scene"],
    ),
    "mechanical": (
        ["mechanical, industrial machinery, gears and engines", "a factory of metal"],
        ["organic, natural, living growth", "a lush wild forest"],
    ),
    "love": (
        ["love, romantic devotion, deep affection", "two lovers in a tender embrace"],
        ["hatred, contempt, cold indifference", "bitter loathing between enemies"],
    ),
    "loss": (
        ["loss, bereavement, grief for what is gone", "an empty chair, a vanished presence"],
        ["gain, abundance, joyful reunion", "a homecoming, everything restored"],
    ),
    "joy": (
        ["joy, jubilation, exuberant delight", "a radiant celebration of happiness"],
        ["misery, despair, leaden gloom", "a desolate, joyless scene"],
    ),
    "fear": (
        ["fear, terror, dread and panic", "a frightened figure fleeing in the dark"],
        ["calm, safety, fearless serenity", "a tranquil, reassuring stillness"],
    ),
    "absurdity": (
        ["absurdity, nonsensical and ridiculous", "a surreal, illogical juxtaposition"],
        ["logical, sensible, rational order", "a coherent, orderly arrangement"],
    ),
    "strange": (
        ["strange, bizarre, peculiar and weird", "an utterly strange, otherworldly apparition"],
        ["normal, ordinary, conventional", "a familiar, unremarkable everyday moment"],
    ),
}

SQUASH = 2.2  # must match mood.ts


def build_axes(embedder: Embedder) -> dict[str, np.ndarray]:
    axes: dict[str, np.ndarray] = {}
    for axis in MOOD_AXES:
        pos, neg = _CONTRASTS[axis]
        p = embedder.embed_texts(pos).mean(axis=0)
        n = embedder.embed_texts(neg).mean(axis=0)
        axes[axis] = l2_normalize((p - n).reshape(1, -1))[0]
    return axes


def project_mood(embedding: np.ndarray, axes: dict[str, np.ndarray]) -> dict[str, float]:
    out: dict[str, float] = {}
    for axis in MOOD_AXES:
        d = float(np.dot(embedding, axes[axis]))
        out[axis] = round(1.0 / (1.0 + np.exp(-SQUASH * d)), 4)
    return out

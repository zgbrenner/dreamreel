"""Author + embed the text pool: original surreal drifting lines and intertitle cards.

All text here is original writing for DREAMREEL. We do NOT reproduce Finnegans Wake or any
other in-copyright text. Embeddings are CLIP text features in the same space as the images.
"""

from __future__ import annotations

import numpy as np

from .clip_backend import Embedder

# Original stream-of-consciousness drifting lines.
DRIFT_LINES = [
    "the clock has forgotten which hour it was promising",
    "a tide of photographs goes out and never returns",
    "somewhere a projector dreams it is a lighthouse",
    "the faces in the wallpaper agree to be patient",
    "rust learns the shape of every hand that left",
    "the moon is only a coin we keep losing on purpose",
    "gardens close their eyes when no one is counting",
    "machines hum the lullaby they were never taught",
    "the sea keeps a museum of everything it swallowed",
    "a door opens onto the inside of another morning",
    "every mirror is a window that gave up traveling",
    "the dust remembers the dancing better than the floor",
    "we left the lamp on for a ghost who prefers the dark",
    "the map folds itself into a bird and forgets the country",
    "an orchestra of clocks tunes itself to the wrong evening",
    "the photograph keeps smiling long after the room is gone",
    # — new lines —
    "the corridor ends before the walking does",
    "water holds the shape of every stone it passed through",
    "a spool of silence unwinds into the next room",
    "the film burns slowly from the inside of its own noon",
    "doors remember being trees and still feel the wind",
    "the lens clouded over and kept what it saw private",
    "somewhere under the floorboards a tide is keeping time",
    "the reel answers but no one recalls asking the question",
    "fog arrives with the address of someone who moved away",
    "clocks without hands count only the hours they refuse",
    "a candle argues with its own shadow until morning",
    "the room has memorised all its former furniture",
    "ink decides to become water and forgets the letter",
    "a bell tower dreams of the bell it no longer carries",
    "the projector gate holds one frame forever between pulses",
    "glass recalls light the way bone recalls the cold",
]

# Original intertitle cards (Bodoni, caps).
INTERTITLES = [
    "AND THEN THE LIGHT REMEMBERED US",
    "A REEL WITH NO BEGINNING",
    "THE PROJECTIONIST HAS FALLEN ASLEEP",
    "WHAT THE WATER KEPT",
    "INTERMISSION FOR THE DROWNED ORCHESTRA",
    "WE NEVER LEFT THE THEATRE",
    # — new cards —
    "THE GATE HOLDS ONE FRAME",
    "ALL CLOCKS SET TO ELSEWHERE",
    "THE AUDIENCE HAS BECOME THE SCREEN",
    "FILM ENDS WHERE THE DARK BEGINS",
]


def build_texts(embedder: Embedder) -> list[dict]:
    """Return text-pool asset dicts (without final id formatting) with embeddings."""
    rows: list[dict] = []
    drift_emb = embedder.embed_texts(DRIFT_LINES)
    card_emb = embedder.embed_texts(INTERTITLES)

    for i, (line, emb) in enumerate(zip(DRIFT_LINES, drift_emb)):
        rows.append(
            {
                "id": f"txt-drift-{i}",
                "type": "titlecard",
                "text": line,
                "embedding": emb,
                "tags": ["drift", "whisper"],
                "dwellBase": 4.0,
                "source": "DREAMREEL / original",
                "license": "CC0",
            }
        )
    for i, (line, emb) in enumerate(zip(INTERTITLES, card_emb)):
        rows.append(
            {
                "id": f"txt-card-{i}",
                "type": "titlecard",
                "text": line,
                "embedding": emb,
                "tags": ["intertitle", "card"],
                "dwellBase": 5.0,
                "source": "DREAMREEL / original",
                "license": "CC0",
            }
        )
    return rows


def procedural_seed_embeddings(embedder: Embedder) -> dict[str, np.ndarray]:
    """Synthetic-but-meaningful embeddings for procedural kinds, via descriptive text."""
    prompts = {
        "leader": "academy film countdown leader, crosshair, numbers",
        "fog": "thick drifting fog and haze",
        "stars": "a field of stars in the night sky",
        "iris": "an optical iris vignette of light",
        "ripple": "concentric ripples on dark water",
        "static": "television static noise and grain",
        "horizon": "a hazy distant horizon at dusk",
        "orbs": "soft glowing floating orbs of light",
        "filmrun": "running film strip with sprocket holes",
    }
    kinds = list(prompts)
    embs = embedder.embed_texts([prompts[k] for k in kinds])
    return {k: e for k, e in zip(kinds, embs)}

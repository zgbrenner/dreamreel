# pipeline/tests/test_audio_ingest.py
from audio.ingest import normalize_audio


def _raw(**over):
    base = {
        "id": "a1",
        "kind": "music",
        "source_url": "https://archive.org/x.mp3",
        "source": "Archive.org / 78rpm",
        "license": "PD",
        "tags": ["jazz", "1920s"],
        "duration_sec": 120.0,
        "loopable": False,
    }
    base.update(over)
    return base


def test_keeps_pd_and_cc0_drops_disallowed():
    rows = [
        _raw(id="ok-pd", license="PD"),
        _raw(id="ok-cc0", license="CC0"),
        _raw(id="bad-nc", license="CC-BY-NC-4.0"),
        _raw(id="bad-unknown", license="All Rights Reserved"),
    ]
    out = normalize_audio(rows)
    ids = {r["id"] for r in out}
    assert ids == {"ok-pd", "ok-cc0"}


def test_drops_unknown_kind_and_too_short():
    rows = [
        _raw(id="bad-kind", kind="podcast"),
        _raw(id="short-voice", kind="voice", duration_sec=1.0),  # < voice min 3.0
        _raw(id="ok-voice", kind="voice", duration_sec=6.0),
    ]
    out = normalize_audio(rows)
    assert {r["id"] for r in out} == {"ok-voice"}


def test_carries_attribution_through():
    rows = [_raw(id="cc-by", license="CC-BY-4.0", attribution="Jane Doe",
                 attribution_url="https://example.com")]
    out = normalize_audio(rows)
    assert out[0]["attribution"] == "Jane Doe"
    assert out[0]["attribution_url"] == "https://example.com"

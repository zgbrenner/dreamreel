"""Film-clip native audio transcode + R2 upload of audio media."""
from __future__ import annotations

from pathlib import Path

from publish.transcode import transcode_video_with_audio, build_clip_audio_cmd


def test_clip_audio_cmd_keeps_soundtrack():
    cmd = build_clip_audio_cmd(Path("in.mp4"), Path("out.mp4"), max_seconds=12, start_seconds=4.0)
    assert "-an" not in cmd            # soundtrack preserved
    assert "-c:a" in cmd and "aac" in cmd
    assert cmd[cmd.index("-t") + 1] == "12"
    assert cmd.index("-ss") < cmd.index("-i")  # fast seek
    assert "+faststart" in cmd


def test_publish_strips_local_from_audio_and_rewrites_src():
    from publish.upload_r2 import _rewrite_for_upload
    manifest = {
        "audio": [
            {"id": "m1", "kind": "music", "src": "https://orig/x.m4a",
             "_local": "/tmp/x.m4a", "embedding": [0.1], "mood": {}, "tags": [],
             "durationSec": 80.0, "loopable": False, "dwellBase": 60.0,
             "source": "Musopen", "license": "PD"},
        ],
    }
    media_urls = {"m1": "https://cdn.example/r2/media/x.m4a"}
    rewritten = _rewrite_for_upload(manifest, media_urls)
    a = rewritten["audio"][0]
    assert "_local" not in a
    assert a["src"] == "https://cdn.example/r2/media/x.m4a"
    assert a["src"].endswith(".m4a")

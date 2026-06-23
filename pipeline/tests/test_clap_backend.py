import numpy as np
from audio.clap_backend import get_audio_embedder


def test_fallback_is_deterministic_and_normalized(tmp_path):
    emb = get_audio_embedder(allow_fallback=True)
    assert emb.backend == "hash-fallback"  # no laion_clap installed in CI
    assert emb.dim == 512

    # text embeddings: same text -> identical vector, L2-normalized
    a = emb.embed_texts(["a steam train"])
    b = emb.embed_texts(["a steam train"])
    assert a.shape == (1, 512)
    assert np.allclose(a, b)
    assert np.allclose(np.linalg.norm(a, axis=-1), 1.0)

    # audio embeddings keyed by file content: same bytes -> same vector
    p1 = tmp_path / "x.wav"
    p1.write_bytes(b"RIFF....WAVEdata1234")
    p2 = tmp_path / "y.wav"
    p2.write_bytes(b"RIFF....WAVEdata1234")
    va = emb.embed_audio([str(p1)])
    vb = emb.embed_audio([str(p2)])
    assert va.shape == (1, 512)
    assert np.allclose(va, vb)  # identical bytes -> identical embedding

    # different content -> different vector
    p3 = tmp_path / "z.wav"
    p3.write_bytes(b"RIFF....WAVEdataDIFFERENT")
    vc = emb.embed_audio([str(p3)])
    assert not np.allclose(va, vc)

    # empty inputs -> shape (0, dim)
    assert emb.embed_texts([]).shape == (0, 512)
    assert emb.embed_audio([]).shape == (0, 512)

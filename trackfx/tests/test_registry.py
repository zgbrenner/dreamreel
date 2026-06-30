from trackfx import effects


def test_expected_effects_registered():
    assert effects.available() == sorted(
        ["tint", "ghost_trail", "dream_gate", "glitch_resolve"]
    )


def test_get_unknown_effect_raises():
    try:
        effects.get("does-not-exist")
    except ValueError as exc:
        assert "Unknown effect" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_register_duplicate_name_raises():
    @effects.register("__test_dummy__")
    def _dummy(frame, detections, ctx):  # pragma: no cover - never called
        return frame

    try:
        @effects.register("__test_dummy__")
        def _dummy2(frame, detections, ctx):  # pragma: no cover
            return frame
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError on duplicate registration")

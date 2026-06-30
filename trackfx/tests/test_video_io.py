from trackfx.video_io import compute_target_size


def test_full_resolution_when_no_max_width():
    assert compute_target_size((1920, 1080), None) == (1920, 1080)


def test_full_resolution_when_max_width_exceeds_source():
    assert compute_target_size((640, 360), 1280) == (640, 360)


def test_proxy_downscales_preserving_aspect_and_even_dims():
    width, height = compute_target_size((1920, 1080), 640)
    assert width == 640
    assert width % 2 == 0
    assert height % 2 == 0
    # aspect ratio preserved within rounding
    assert abs((width / height) - (1920 / 1080)) < 0.02


def test_proxy_never_upscales():
    width, height = compute_target_size((320, 240), 640)
    assert (width, height) == (320, 240)

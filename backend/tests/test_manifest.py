from app.services.manifest import load_test_manifest


def test_manifest_contains_exactly_100_real_test_videos():
    videos = load_test_manifest()

    assert len(videos) == 100
    assert all(video.split == "test" for video in videos)
    assert all(video.filepath.is_file() for video in videos)
    assert all(video.filepath.suffix.lower() == ".mp4" for video in videos)


def test_manifest_ids_are_unique_and_stable():
    videos = load_test_manifest()

    assert [video.manifest_id for video in videos] == list(range(1, 101))
    assert len({video.filename for video in videos}) == 100

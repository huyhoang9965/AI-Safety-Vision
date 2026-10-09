from fractions import Fraction
from types import SimpleNamespace

import av
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.middleware.cors import CORSMiddleware

from app.api import videos
from app.services import video_catalog, video_playback


def test_preview_faststart_size_timestamps_cache_and_original_are_preserved(tmp_path, monkeypatch):
    monkeypatch.setattr(video_playback, "get_settings", lambda: SimpleNamespace(output_dir=tmp_path))
    source = tmp_path / "original.mp4"
    # VFR includes adjacent frames closer than 1/25 sec. Rounding to 1/fps
    # used to duplicate DTS on the safe forklift control clip.
    timestamps = [0, 3600, 7100, 7500, 10800, 14400, 18000, 21600]
    with av.open(str(source), "w") as container:
        stream = container.add_stream("libx264", rate=25)
        stream.width, stream.height, stream.pix_fmt = 1600, 900, "yuv420p"
        stream.codec_context.thread_count = 1
        stream.codec_context.time_base = Fraction(1, 90000)
        stream.options = {"preset": "ultrafast", "crf": "21"}
        for pts in timestamps:
            frame = av.VideoFrame.from_ndarray(np.full((900, 1600, 3), 40 + pts // 1000, dtype=np.uint8), format="rgb24")
            frame.pts, frame.time_base = pts, Fraction(1, 90000)
            for packet in stream.encode(frame): container.mux(packet)
        for packet in stream.encode(): container.mux(packet)
    original = source.read_bytes()
    original_url = video_playback.playback_url(123, source)
    assert video_playback.playback_path(source) == source
    target = video_playback.prepare_preview(source)
    assert target != source
    assert source.read_bytes() == original
    assert video_playback.playback_path(source) == target
    data = target.read_bytes()
    assert data.find(b"moov") < data.find(b"mdat")
    with av.open(str(target)) as preview:
        stream = preview.streams.video[0]
        assert (stream.width, stream.height) == (1280, 720)
        assert stream.codec_context.name == "h264"
        times = [float(frame.pts * frame.time_base) for frame in preview.decode(video=0)]
    assert len(times) == len(timestamps)
    assert all(abs(actual - expected / 90000) < .0001 for actual, expected in zip(times, timestamps))
    assert all(first < second for first, second in zip(times, times[1:]))
    modified = target.stat().st_mtime_ns
    assert video_playback.prepare_preview(source) == target
    assert target.stat().st_mtime_ns == modified
    source.touch()
    assert video_playback.playback_path(source) == source  # A changed source cannot reuse stale media.
    assert video_playback.playback_url(123, source) != original_url


def test_stream_supports_partial_reads_of_preview_and_original_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(video_playback, "get_settings", lambda: SimpleNamespace(output_dir=tmp_path))
    source = tmp_path / "original.mp4"
    source.write_bytes(b"original-video" * 500)
    target = video_playback.preview_path(source)
    target.parent.mkdir(parents=True)
    preview = b"preview-video" * 100
    target.write_bytes(preview)
    monkeypatch.setattr(videos, "resolve_stream_video", lambda _id: SimpleNamespace(filepath=source, filename=source.name))
    app = FastAPI()
    app.include_router(videos.router)
    with TestClient(app) as client:
        response = client.get("/api/videos/1/stream", headers={"Range": "bytes=10-99"})
        assert response.status_code == 206
        assert response.content == preview[10:100]
        assert response.headers["content-range"] == f"bytes 10-99/{len(preview)}"
        assert response.headers["accept-ranges"] == "bytes"
        assert response.headers["cache-control"] == "public, max-age=3600"
        assert response.headers["vary"] == "Origin"
        assert client.get("/api/videos/1/stream", headers={"Range": "bytes=99999-"}).status_code == 416
        target.unlink()
        assert client.get("/api/videos/1/stream", headers={"Range": "bytes=0-7"}).content == b"original"


def test_media_lookup_does_not_reconnect_for_every_range_and_expires(monkeypatch):
    clock = [0]
    lookups = []
    video = SimpleNamespace(id=123)
    monkeypatch.setattr(video_catalog, "_stream_catalog", {})
    monkeypatch.setattr(video_catalog, "monotonic", lambda: clock[0])
    def resolve(video_id):
        lookups.append(video_id)
        return video if video_id == 123 else None
    monkeypatch.setattr(video_catalog, "resolve_video", resolve)
    assert video_catalog.resolve_stream_video(123) is video
    assert video_catalog.resolve_stream_video(123) is video
    assert lookups == [123]
    clock[0] = 301
    assert video_catalog.resolve_stream_video(123) is video
    assert lookups == [123, 123]
    assert video_catalog.resolve_stream_video(999) is None


def test_catalog_can_still_describe_missing_source_without_crashing(tmp_path):
    assert video_playback.playback_url(12, tmp_path / "missing.mp4") == "/api/videos/12/stream"


def test_stream_cache_varies_by_origin_even_after_plain_video_preload(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"original-video" * 500)
    monkeypatch.setattr(video_playback, "get_settings", lambda: SimpleNamespace(output_dir=tmp_path))
    monkeypatch.setattr(videos, "resolve_stream_video", lambda _id: SimpleNamespace(filepath=source, filename=source.name))
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_credentials=True)
    app.include_router(videos.router)
    url = video_playback.playback_url(1, source)
    assert "&cors=1" in url  # Bypass browser responses cached before this fix.
    with TestClient(app) as client:
        for origin in [None, "http://localhost:3000", "http://127.0.0.1:3000", "https://unrelated.example"]:
            headers = {"Range": "bytes=0-99"}
            if origin: headers["Origin"] = origin
            response = client.get(url, headers=headers)
            assert response.status_code == 206
            assert "origin" in response.headers["vary"].lower()
            if origin and origin.startswith("http://"):
                assert response.headers["access-control-allow-origin"] == origin
            else:
                assert "access-control-allow-origin" not in response.headers

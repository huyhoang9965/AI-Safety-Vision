"""Small, browser-ready copies; inference and evidence always use the original."""
from __future__ import annotations

import hashlib
import json
import logging
from fractions import Fraction
from pathlib import Path
from threading import Lock
from uuid import uuid4

from app.config import get_settings

logger = logging.getLogger(__name__)
_build_lock = Lock()
PREVIEW_VERSION = "h264-720p-crf21-faststart-v2"


def preview_path(source: Path) -> Path:
    stat = source.stat()
    fingerprint = f"{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}:{PREVIEW_VERSION}"
    digest = hashlib.sha256(fingerprint.encode()).hexdigest()[:16]
    return get_settings().output_dir / "playback" / f"{source.stem}-{digest}.mp4"


def playback_path(source: Path) -> Path:
    candidate = preview_path(source)
    return candidate if candidate.is_file() else source


def playback_url(video_id: int, source: Path) -> str:
    if not source.is_file():
        return f"/api/videos/{video_id}/stream"
    # Invalidate older browser responses that did not vary by Origin, without
    # rebuilding the prepared MP4 or disabling range/cache playback.
    return f"/api/videos/{video_id}/stream?v={preview_path(source).stem}&cors=1"


def prepare_preview(source: Path) -> Path:
    import av

    target = preview_path(source)
    with _build_lock:
        if target.is_file():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.stem}-{uuid4().hex}.tmp.mp4")
        try:
            with av.open(str(source)) as original:
                video = original.streams.video[0]
                video.codec_context.thread_count = 2
                scale = min(1, 1280 / video.width)
                width = max(2, round(video.width * scale) // 2 * 2)
                height = max(2, round(video.height * scale) // 2 * 2)
                rate = Fraction(video.average_rate or 25).limit_denominator(1000)
                with av.open(str(temporary), "w", options={"movflags": "+faststart"}) as output:
                    stream = output.add_stream("libx264", rate=rate)
                    stream.width, stream.height = width, height
                    stream.pix_fmt = "yuv420p"
                    # Keep VFR timestamps precise instead of rounding them to
                    # 1/fps, which can produce duplicate DTS on dataset clips.
                    stream.time_base = Fraction(1, 90000)
                    stream.codec_context.time_base = Fraction(1, 90000)
                    stream.codec_context.thread_count = 2
                    stream.codec_context.gop_size = max(1, round(float(rate)))
                    stream.options = {"preset": "veryfast", "crf": "21", "profile": "main"}
                    audio = {item.index: output.add_stream_from_template(item) for item in original.streams.audio}
                    for packet in original.demux():
                        if packet.stream.type == "audio":
                            if packet.dts is not None:
                                packet.stream = audio[packet.stream.index]
                                output.mux(packet)
                        elif packet.stream.index == video.index:
                            for frame in packet.decode():
                                resized = frame.reformat(width=width, height=height, format="yuv420p")
                                resized.pts, resized.time_base = frame.pts, frame.time_base
                                for encoded in stream.encode(resized):
                                    output.mux(encoded)
                    for encoded in stream.encode():
                        output.mux(encoded)
            temporary.replace(target)
            return target
        finally:
            temporary.unlink(missing_ok=True)


def warmup_demo_previews() -> None:
    from app.services.manifest import load_test_manifest

    presets = get_settings().project_root / "web" / "lib" / "demo-camera-presets.json"
    if not presets.is_file():
        return
    filenames = {name for camera in json.loads(presets.read_text(encoding="utf-8")) for name in camera["filenames"]}
    for video in load_test_manifest():
        if video.filename in filenames and video.filepath.is_file():
            try:
                prepare_preview(video.filepath)
            except Exception:
                logger.exception("Could not prepare playback copy for %s", video.filename)

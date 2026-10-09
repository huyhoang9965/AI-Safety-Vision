"""Generate playback copies without changing datasets or running AI."""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
from app.services.video_playback import warmup_demo_previews
from app.services.video_playback import playback_path, playback_url
from app.services.video_catalog import list_test_videos
from app.config import get_settings

if __name__ == "__main__":
    warmup_demo_previews()
    settings = get_settings()
    presets = json.loads((settings.project_root / "web/lib/demo-camera-presets.json").read_text(encoding="utf-8"))
    curated = {name for camera in presets for name in camera["filenames"]}
    report = []
    for video in list_test_videos():
        if video.filename not in curated:
            continue
        preview = playback_path(video.filepath)
        if preview == video.filepath:
            raise RuntimeError(f"Playback copy missing: {video.filename}")
        report.append({"id": video.id, "filename": video.filename, "width": video.width, "height": video.height,
                       "duration": video.duration, "fps": video.fps, "labels": list(video.labels),
                       "stream_url": playback_url(video.id, video.filepath), "preview_path": str(preview),
                       "source_bytes": video.filepath.stat().st_size, "preview_bytes": preview.stat().st_size})
    (settings.output_dir / "playback-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Ready: {len(report)} playback copies; {sum(item['source_bytes'] for item in report)/1048576:.1f} MB -> {sum(item['preview_bytes'] for item in report)/1048576:.1f} MB")

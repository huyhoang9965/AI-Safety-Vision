from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from app.database import database
from app.services.manifest import ManifestVideo, get_manifest_video, load_test_manifest

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedVideo:
    id: int
    filename: str
    filepath: Path
    labels: tuple[str, ...]
    duration: float | None
    width: int | None
    height: int | None
    fps: float | None


def _manifest_by_path() -> dict[str, ManifestVideo]:
    return {str(video.filepath).lower(): video for video in load_test_manifest()}


def list_test_videos() -> list[ResolvedVideo]:
    manifest_videos = load_test_manifest()
    if database.is_database_available():
        try:
            database.sync_videos(manifest_videos)
            database_rows = database.list_test_videos()
            manifest_map = _manifest_by_path()
            resolved = []
            for row in database_rows:
                manifest = manifest_map.get(str(Path(row["filepath"]).resolve()).lower())
                if manifest is None:
                    continue
                resolved.append(
                    ResolvedVideo(
                        id=int(row["id"]),
                        filename=row["filename"],
                        filepath=Path(row["filepath"]),
                        labels=manifest.labels,
                        duration=row["duration"],
                        width=manifest.width,
                        height=manifest.height,
                        fps=manifest.fps,
                    )
                )
            if len(resolved) == len(manifest_videos):
                return resolved
        except Exception as exc:
            logger.warning("Falling back to manifest video IDs: %s", exc)

    return [
        ResolvedVideo(
            id=video.manifest_id,
            filename=video.filename,
            filepath=video.filepath,
            labels=video.labels,
            duration=video.duration,
            width=video.width,
            height=video.height,
            fps=video.fps,
        )
        for video in manifest_videos
    ]


def resolve_video(video_id: int) -> ResolvedVideo | None:
    if database.is_database_available():
        try:
            row = database.get_video(video_id)
            if row:
                manifest = _manifest_by_path().get(str(row.filepath.resolve()).lower())
                if manifest:
                    return ResolvedVideo(
                        id=row.id,
                        filename=row.filename,
                        filepath=row.filepath,
                        labels=manifest.labels,
                        duration=row.duration,
                        width=manifest.width,
                        height=manifest.height,
                        fps=manifest.fps,
                    )
        except Exception as exc:
            logger.warning("Database video lookup failed: %s", exc)

    manifest = get_manifest_video(video_id)
    if manifest is None:
        return None
    return ResolvedVideo(
        id=manifest.manifest_id,
        filename=manifest.filename,
        filepath=manifest.filepath,
        labels=manifest.labels,
        duration=manifest.duration,
        width=manifest.width,
        height=manifest.height,
        fps=manifest.fps,
    )

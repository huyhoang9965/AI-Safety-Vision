from __future__ import annotations

import csv
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.config import get_settings


@dataclass(frozen=True)
class ManifestVideo:
    manifest_id: int
    filename: str
    filepath: Path
    split: str
    labels: tuple[str, ...]
    duration: float | None
    width: int | None
    height: int | None
    fps: float | None


def _optional_float(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _optional_int(value: str | None) -> int | None:
    number = _optional_float(value)
    return int(number) if number is not None else None


def _resolve_video_path(row: dict[str, str]) -> Path:
    settings = get_settings()
    canonical = Path(row.get("canonical_path", ""))
    if canonical.is_file():
        return canonical.resolve()

    relative = row.get("relative_path", "").replace("/", os_separator())
    candidate = settings.dataset_root / relative
    if candidate.is_file():
        return candidate.resolve()

    fallback = settings.dataset_root / "data" / row["canonical_filename"]
    return fallback.resolve()


def os_separator() -> str:
    return "\\" if Path("C:/").anchor else "/"


@lru_cache(maxsize=1)
def load_test_manifest() -> tuple[ManifestVideo, ...]:
    settings = get_settings()
    if not settings.manifest_path.is_file():
        raise FileNotFoundError(f"Manifest not found: {settings.manifest_path}")

    with settings.manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("final_split") == "test"]

    rows.sort(key=lambda item: item.get("canonical_filename", "").lower())
    videos: list[ManifestVideo] = []
    for index, row in enumerate(rows, start=1):
        labels = tuple(label.strip() for label in row.get("labels_text", "").split("|") if label.strip())
        videos.append(
            ManifestVideo(
                manifest_id=index,
                filename=row["canonical_filename"],
                filepath=_resolve_video_path(row),
                split="test",
                labels=labels,
                duration=_optional_float(row.get("duration_sec")),
                width=_optional_int(row.get("width")),
                height=_optional_int(row.get("height")),
                fps=_optional_float(row.get("fps")),
            )
        )

    if len(videos) != 100:
        raise RuntimeError(f"Expected 100 final_split=test videos, found {len(videos)}")
    return tuple(videos)


def get_manifest_video(video_id: int) -> ManifestVideo | None:
    return next((video for video in load_test_manifest() if video.manifest_id == video_id), None)

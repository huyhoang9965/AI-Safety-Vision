from __future__ import annotations

import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from app.config import get_settings
from app.database.models import DatabaseVideo
from app.services.manifest import ManifestVideo

logger = logging.getLogger(__name__)


def _psycopg():
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError("psycopg is not installed") from exc
    return psycopg, dict_row


@contextmanager
def connection() -> Iterator[Any]:
    psycopg, dict_row = _psycopg()
    with psycopg.connect(get_settings().database_url, connect_timeout=3, row_factory=dict_row) as conn:
        yield conn


def is_database_available() -> bool:
    try:
        with connection() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def initialize_database() -> None:
    sql = get_settings().migration_path.read_text(encoding="utf-8")
    with connection() as conn:
        conn.execute(sql)
        conn.commit()


def sync_videos(videos: Sequence[ManifestVideo]) -> None:
    with connection() as conn:
        for video in videos:
            conn.execute(
                """
                INSERT INTO videos (filename, filepath, split, duration)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (filepath) DO UPDATE SET
                    filename = EXCLUDED.filename,
                    split = EXCLUDED.split,
                    duration = EXCLUDED.duration
                """,
                (video.filename, str(video.filepath), video.split, video.duration),
            )
        conn.commit()


def sync_models(models: Sequence[dict[str, Any]]) -> None:
    with connection() as conn:
        for model in models:
            conn.execute(
                """
                INSERT INTO models (name, type, version, weight_path)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (name) DO UPDATE SET
                    type = EXCLUDED.type,
                    version = EXCLUDED.version,
                    weight_path = EXCLUDED.weight_path
                """,
                (model["name"], model["type"], model["version"], model.get("weight_path")),
            )
        conn.commit()


def list_test_videos() -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, filename, filepath, split, duration FROM videos WHERE split = 'test' ORDER BY filename"
        ).fetchall()
    return list(rows)


def get_video(video_id: int) -> DatabaseVideo | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT id, filename, filepath, split, duration FROM videos WHERE id = %s AND split = 'test'",
            (video_id,),
        ).fetchone()
    if not row:
        return None
    return DatabaseVideo(
        id=row["id"],
        filename=row["filename"],
        filepath=Path(row["filepath"]),
        split=row["split"],
        duration=row["duration"],
    )


def get_video_id_by_path(filepath: Path) -> int | None:
    with connection() as conn:
        row = conn.execute("SELECT id FROM videos WHERE filepath = %s", (str(filepath),)).fetchone()
    return int(row["id"]) if row else None


def create_inference(video_id: int, model_name: str) -> int:
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO inference_history (video_id, model_id, status)
            SELECT %s, id, 'processing' FROM models WHERE name = %s
            RETURNING id
            """,
            (video_id, model_name),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Model is not registered in PostgreSQL: {model_name}")
        conn.commit()
    return int(row["id"])


def complete_inference(
    inference_id: int,
    processing_time: float,
    output_video: str,
    predictions: Sequence[dict[str, Any]],
    detections: Sequence[dict[str, Any]],
) -> None:
    with connection() as conn:
        conn.execute(
            """
            UPDATE inference_history
            SET status = 'completed', processing_time = %s, output_video = %s, error_message = NULL
            WHERE id = %s
            """,
            (processing_time, output_video, inference_id),
        )
        if predictions:
            conn.executemany(
                "INSERT INTO predictions (inference_id, class_name, confidence) VALUES (%s, %s, %s)",
                [(inference_id, item["class_name"], item["confidence"]) for item in predictions],
            )
        if detections:
            conn.executemany(
                """
                INSERT INTO detection_results
                    (inference_id, class_name, confidence, x1, y1, x2, y2, frame_index)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        inference_id,
                        item["class_name"],
                        item["confidence"],
                        item["x1"],
                        item["y1"],
                        item["x2"],
                        item["y2"],
                        item["frame_index"],
                    )
                    for item in detections
                ],
            )
        conn.commit()


def fail_inference(inference_id: int, processing_time: float, message: str) -> None:
    with connection() as conn:
        conn.execute(
            """
            UPDATE inference_history
            SET status = 'failed', processing_time = %s, error_message = %s
            WHERE id = %s
            """,
            (processing_time, message[:1000], inference_id),
        )
        conn.commit()

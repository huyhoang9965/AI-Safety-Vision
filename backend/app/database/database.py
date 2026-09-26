from __future__ import annotations

import logging
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence
from uuid import UUID

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
    with connection() as conn:
        migration_dir = get_settings().migration_path.parent
        for migration in sorted(migration_dir.glob("*.sql")):
            if migration.name.startswith("000_"):
                continue
            conn.execute(migration.read_text(encoding="utf-8"))
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


def find_camera_by_code(
    camera_code: str | None,
    organization_ids: Sequence[UUID | str],
) -> dict[str, Any] | None:
    if not camera_code or not organization_ids:
        return None
    with connection() as conn:
        row = conn.execute(
            """
            SELECT c.id, c.organization_id, c.site_id, c.zone_id, c.code, c.name
            FROM safety.cameras c
            WHERE upper(c.code) = upper(%s)
              AND c.organization_id = ANY(%s::uuid[])
              AND c.is_active
            LIMIT 1
            """,
            (camera_code.strip(), list(organization_ids)),
        ).fetchone()
    return dict(row) if row else None


def create_inference(
    video_id: int,
    model_name: str,
    camera_id: UUID | str | None = None,
    requested_by: UUID | str | None = None,
) -> int:
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO inference_history
                (video_id, model_id, camera_id, requested_by, status, started_at)
            SELECT %s, id, %s, %s, 'processing', now()
            FROM models WHERE name = %s
            RETURNING id
            """,
            (video_id, camera_id, requested_by, model_name),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Model is not registered in PostgreSQL: {model_name}")
        conn.commit()
    return int(row["id"])


def complete_inference(
    inference_id: int,
    processing_time: float,
    output_video: str,
    metrics: dict[str, Any],
    predictions: Sequence[dict[str, Any]],
    detections: Sequence[dict[str, Any]],
) -> None:
    with connection() as conn:
        conn.execute(
            """
            UPDATE inference_history
            SET status = 'completed', processing_time = %s, output_video = %s,
                metrics = %s::jsonb, completed_at = now(), error_message = NULL
            WHERE id = %s
            """,
            (processing_time, output_video, json.dumps(metrics), inference_id),
        )
        conn.execute("DELETE FROM predictions WHERE inference_id = %s", (inference_id,))
        conn.execute("DELETE FROM detection_results WHERE inference_id = %s", (inference_id,))
        with conn.cursor() as cursor:
            if predictions:
                cursor.executemany(
                    "INSERT INTO predictions (inference_id, class_name, confidence) VALUES (%s, %s, %s)",
                    [(inference_id, item["class_name"], item["confidence"]) for item in predictions],
                )
            if detections:
                cursor.executemany(
                    """
                    INSERT INTO detection_results
                        (inference_id, class_name, confidence, x1, y1, x2, y2,
                         frame_index, is_violation, track_id, evidence_url, evidence_basis)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                            bool(item.get("is_violation", False)),
                            str(item["track_id"]) if item.get("track_id") is not None else None,
                            item.get("evidence_url"),
                            item.get("evidence_basis"),
                        )
                        for item in detections
                    ],
                )
        conn.commit()


def create_safety_events(
    inference_id: int,
    camera_id: UUID | str,
    candidates: Sequence[dict[str, Any]],
) -> list[str]:
    """Persist dashboard events and their alert rows in one transaction."""
    event_ids: list[str] = []
    with connection() as conn:
        for candidate in candidates:
            raw_payload = candidate.get("raw_payload", {})
            evidence = raw_payload.get("evidence", {})
            prior = conn.execute(
                """
                SELECT e.id
                FROM safety.safety_events e
                JOIN safety.event_types et ON et.id = e.event_type_id
                WHERE e.camera_id = %s
                  AND et.code = %s
                  AND e.raw_payload->>'source_video' = %s
                  AND e.raw_payload->>'model' = %s
                  AND COALESCE(e.raw_payload #>> '{evidence,track_id}', '') = %s
                ORDER BY e.detected_at DESC
                LIMIT 1
                """,
                (
                    camera_id,
                    candidate["event_code"],
                    raw_payload.get("source_video"),
                    raw_payload.get("model"),
                    str(evidence.get("track_id")) if evidence.get("track_id") is not None else "",
                ),
            ).fetchone()
            if prior is not None:
                event_ids.append(str(prior["id"]))
                continue
            row = conn.execute(
                """
                INSERT INTO safety.safety_events (
                    organization_id, site_id, zone_id, camera_id, event_type_id,
                    inference_id, severity, status, confidence, title, description,
                    object_count, snapshot_url, video_url, thumbnail_url,
                    bounding_boxes, raw_payload, deduplication_key, detected_at
                )
                SELECT c.organization_id, c.site_id, c.zone_id, c.id, et.id,
                       ih.id, et.default_severity, 'new', %s, %s, %s, %s,
                       %s, %s, %s, %s::jsonb, %s::jsonb, %s, now()
                FROM safety.cameras c
                JOIN safety.event_types et ON et.code = %s AND et.is_active
                JOIN public.inference_history ih ON ih.id = %s AND ih.camera_id = c.id
                WHERE c.id = %s AND c.is_active
                ON CONFLICT (organization_id, deduplication_key)
                    WHERE deduplication_key IS NOT NULL
                DO NOTHING
                RETURNING id, organization_id
                """,
                (
                    candidate.get("confidence"),
                    candidate["title"],
                    candidate.get("description"),
                    candidate.get("object_count", 1),
                    candidate.get("snapshot_url"),
                    candidate.get("video_url"),
                    candidate.get("thumbnail_url"),
                    json.dumps(candidate.get("bounding_boxes", [])),
                    json.dumps(candidate.get("raw_payload", {})),
                    candidate["deduplication_key"],
                    candidate["event_code"],
                    inference_id,
                    camera_id,
                ),
            ).fetchone()
            if row is None:
                existing = conn.execute(
                    """
                    SELECT id, organization_id
                    FROM safety.safety_events
                    WHERE deduplication_key = %s
                      AND organization_id = (
                          SELECT organization_id FROM safety.cameras WHERE id = %s
                      )
                    """,
                    (candidate["deduplication_key"], camera_id),
                ).fetchone()
                if existing is not None:
                    event_ids.append(str(existing["id"]))
                continue

            event_id = row["id"]
            event_ids.append(str(event_id))
            detected_object = candidate.get("detected_object")
            if detected_object:
                conn.execute(
                    """
                    INSERT INTO safety.event_objects (
                        event_id, tracking_id, class_name, confidence,
                        bbox_x, bbox_y, bbox_width, bbox_height, attributes
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        event_id,
                        detected_object.get("tracking_id"),
                        detected_object["class_name"],
                        detected_object.get("confidence"),
                        detected_object.get("bbox_x"),
                        detected_object.get("bbox_y"),
                        detected_object.get("bbox_width"),
                        detected_object.get("bbox_height"),
                        json.dumps(detected_object.get("attributes", {})),
                    ),
                )
            conn.execute(
                """
                INSERT INTO safety.alerts (
                    organization_id, event_id, status, title, message
                )
                VALUES (%s, %s, 'pending', %s, %s)
                ON CONFLICT (event_id) DO NOTHING
                """,
                (
                    row["organization_id"],
                    event_id,
                    candidate["title"],
                    candidate.get("description") or candidate["title"],
                ),
            )
    return event_ids


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

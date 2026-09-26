from __future__ import annotations

import logging
from hashlib import sha256
from dataclasses import dataclass
from pathlib import Path
from threading import BoundedSemaphore, Event, Lock
from time import perf_counter
from typing import Any
from uuid import UUID, uuid4

from app.config import get_settings
from app.database import database
from app.models.base import InferenceOutput
from app.models.registry import registry
from app.services.video_catalog import ResolvedVideo

logger = logging.getLogger(__name__)


VIOLATION_EVENT_CODES = {
    "suspected no helmet": "SUSPECTED_NO_HELMET",
    "suspected no vest": "SUSPECTED_NO_VEST",
    "safe walkway violation": "SAFE_WALKWAY_VIOLATION",
    "unauthorized intervention": "UNAUTHORIZED_INTERVENTION",
    "opened panel cover": "OPENED_PANEL_COVER",
    "carrying overload with forklift": "FORKLIFT_OVERLOAD",
    "fall detected": "FALL_DETECTED",
    "fire smoke": "FIRE_SMOKE",
    "restricted area": "RESTRICTED_AREA",
    "crowding": "CROWDING",
    "unsafe behavior": "UNSAFE_BEHAVIOR",
}

VIOLATION_TITLES = {
    "SUSPECTED_NO_HELMET": "Nghi ngờ không đội mũ bảo hộ",
    "SUSPECTED_NO_VEST": "Nghi ngờ không mặc áo bảo hộ",
    "SAFE_WALKWAY_VIOLATION": "Đi vào khu vực nguy hiểm",
    "UNAUTHORIZED_INTERVENTION": "Can thiệp trái phép",
    "OPENED_PANEL_COVER": "Nắp tủ điện đang mở",
    "FORKLIFT_OVERLOAD": "Xe nâng chở quá tải",
    "FALL_DETECTED": "Phát hiện té ngã",
    "FIRE_SMOKE": "Phát hiện lửa hoặc khói",
    "RESTRICTED_AREA": "Xâm nhập khu vực cấm",
    "CROWDING": "Tập trung đông người",
    "UNSAFE_BEHAVIOR": "Hành vi không an toàn",
}


@dataclass(frozen=True)
class PersistenceContext:
    inference_id: int
    camera_id: UUID | None
    camera_code: str | None


@dataclass(frozen=True)
class InferenceServiceResult:
    inference_id: int | None
    model_name: str
    model_type: str
    prediction: str
    confidence: float
    output_video: str
    processing_time: float
    metrics: dict[str, Any]
    persisted: bool
    event_ids: tuple[str, ...] = ()


_cache_lock = Lock()
_result_cache: dict[tuple[str, str, str], InferenceServiceResult] = {}
_inflight: dict[tuple[str, str, str], Event] = {}
_inference_errors: dict[tuple[str, str, str], str] = {}
_model_locks: dict[str, Lock] = {}
_inference_slots = BoundedSemaphore(max(1, get_settings().ai_max_concurrent_inference))


def _organization_ids(user: dict[str, Any] | None) -> list[UUID | str]:
    if not user:
        return []
    return [
        membership["organization_id"]
        for membership in user.get("memberships", [])
        if membership.get("organization_id")
    ]


def _start_history(
    video: ResolvedVideo,
    model_name: str,
    camera_code: str | None,
    user: dict[str, Any] | None,
) -> tuple[PersistenceContext | None, bool]:
    if not database.is_database_available():
        return None, False
    try:
        database.sync_models(registry.catalog_rows())
        database_video_id = database.get_video_id_by_path(video.filepath)
        if database_video_id is None:
            return None, False
        camera = database.find_camera_by_code(camera_code, _organization_ids(user))
        inference_id = database.create_inference(
            database_video_id,
            model_name,
            camera_id=camera["id"] if camera else None,
            requested_by=user.get("id") if user else None,
        )
        return PersistenceContext(
            inference_id=inference_id,
            camera_id=camera["id"] if camera else None,
            camera_code=camera["code"] if camera else camera_code,
        ), True
    except Exception as exc:
        logger.warning("Inference will run without PostgreSQL persistence: %s", exc)
        return None, False


def _save_video_snapshot(video_path: Path, output_dir: Path, inference_id: int) -> str | None:
    """Save a representative JPEG for classification violations."""
    try:
        import cv2

        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            return None
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if frame_count > 1:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_count // 2)
        ok, frame = capture.read()
        capture.release()
        if not ok:
            return None
        output_dir.mkdir(parents=True, exist_ok=True)
        evidence_path = output_dir / (
            f"inference_{inference_id}_evidence_{uuid4().hex[:8]}.jpg"
        )
        if not cv2.imwrite(str(evidence_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 98]):
            return None
        return f"/results/{evidence_path.name}"
    except Exception as exc:
        logger.warning("Could not create classification evidence image: %s", exc)
        return None


def _probability(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, number))


def _detected_object(
    evidence: dict[str, Any],
    metrics: dict[str, Any],
    confidence: float | None,
) -> dict[str, Any] | None:
    bbox = evidence.get("bbox")
    width = metrics.get("frame_width")
    height = metrics.get("frame_height")
    if not isinstance(bbox, list) or len(bbox) != 4 or not width or not height:
        return None
    try:
        x1, y1, x2, y2 = [float(value) for value in bbox]
        frame_width, frame_height = float(width), float(height)
    except (TypeError, ValueError):
        return None
    return {
        "tracking_id": (
            str(evidence["track_id"]) if evidence.get("track_id") is not None else None
        ),
        "class_name": str(evidence.get("class_name", "violation")),
        "confidence": confidence,
        "bbox_x": max(0.0, min(1.0, x1 / frame_width)),
        "bbox_y": max(0.0, min(1.0, y1 / frame_height)),
        "bbox_width": max(0.0, min(1.0, (x2 - x1) / frame_width)),
        "bbox_height": max(0.0, min(1.0, (y2 - y1) / frame_height)),
        "attributes": {
            "frame_index": evidence.get("frame_index"),
            "timestamp_seconds": evidence.get("timestamp_seconds"),
            "basis": evidence.get("basis"),
        },
    }


def _classification_evidence(output: InferenceOutput) -> list[dict[str, Any]]:
    class_scores = output.metrics.get("class_scores", {})
    # Use the same top unsafe class that Demo presents as its alert.
    label = str(output.prediction).strip()
    if label.casefold() not in VIOLATION_EVENT_CODES:
        return []
    return [
        {
            "class_name": label,
            "confidence": class_scores.get(label, output.confidence),
            "basis": "video_classification",
        }
    ]


def _build_violation_candidates(
    output: InferenceOutput,
    video: ResolvedVideo,
    model_name: str,
    output_video: str,
    inference_id: int,
    camera_code: str | None = None,
) -> list[dict[str, Any]]:
    evidence_events = output.metrics.get("evidence_events", [])
    if not isinstance(evidence_events, list):
        evidence_events = []
    if output.type == "classification":
        evidence_events = _classification_evidence(output)
        if evidence_events:
            snapshot = _save_video_snapshot(video.filepath, get_settings().output_dir, inference_id)
            if not snapshot:
                frame_index = max(0, int(video.duration * video.fps / 2))
                snapshot = f"/api/videos/{video.id}/thumbnail?frame_index={frame_index}"
            for evidence in evidence_events:
                evidence["image"] = snapshot
        output.metrics["evidence_events"] = evidence_events

    candidates: list[dict[str, Any]] = []
    for index, raw_evidence in enumerate(evidence_events):
        if not isinstance(raw_evidence, dict):
            continue
        label = str(raw_evidence.get("class_name", "")).strip()
        event_code = VIOLATION_EVENT_CODES.get(label.casefold())
        if not event_code:
            continue
        confidence = _probability(
            raw_evidence.get("confidence")
            if raw_evidence.get("confidence") is not None
            else raw_evidence.get("person_confidence")
        )
        snapshot_url = raw_evidence.get("image")
        if not snapshot_url:
            frame_index = raw_evidence.get("frame_index")
            try:
                frame_index = max(0, int(frame_index))
            except (TypeError, ValueError):
                frame_index = max(0, int(video.duration * video.fps / 2))
            snapshot_url = f"/api/videos/{video.id}/thumbnail?frame_index={frame_index}"
            raw_evidence["image"] = snapshot_url
        track_id = raw_evidence.get("track_id")
        bbox = raw_evidence.get("bbox")
        bounding_boxes = []
        if isinstance(bbox, list) and len(bbox) == 4:
            bounding_boxes.append(
                {
                    "bbox": bbox,
                    "track_id": track_id,
                    "confidence": confidence,
                    "frame_index": raw_evidence.get("frame_index"),
                }
            )
        dedupe_suffix = str(track_id) if track_id is not None else str(index)
        source_key = f"{camera_code or ''}:{video.filename}:{model_name}:{event_code}:{dedupe_suffix}"
        candidates.append(
            {
                "event_code": event_code,
                "title": VIOLATION_TITLES[event_code],
                "description": (
                    f"{model_name} phát hiện từ nguồn {video.filename}. "
                    "Vui lòng kiểm tra ảnh và video bằng chứng trước khi xử lý."
                ),
                "confidence": confidence,
                "object_count": 1,
                "snapshot_url": snapshot_url,
                "thumbnail_url": snapshot_url,
                "video_url": output_video,
                "bounding_boxes": bounding_boxes,
                "raw_payload": {
                    "model": model_name,
                    "source_video": video.filename,
                    "source_video_id": video.id,
                    "label": label,
                    "evidence": raw_evidence,
                },
                "deduplication_key": "demo-video:" + sha256(source_key.encode("utf-8")).hexdigest(),
                "detected_object": _detected_object(
                    raw_evidence, output.metrics, confidence
                ),
            }
        )
    return candidates


def _detections_with_evidence(output: InferenceOutput) -> list[dict[str, Any]]:
    evidence_events = output.metrics.get("evidence_events", [])
    lookup: dict[tuple[str, str | None], str] = {}
    if isinstance(evidence_events, list):
        for evidence in evidence_events:
            if not isinstance(evidence, dict) or not evidence.get("image"):
                continue
            key = (
                str(evidence.get("class_name", "")),
                str(evidence["track_id"]) if evidence.get("track_id") is not None else None,
            )
            lookup[key] = str(evidence["image"])
    enriched: list[dict[str, Any]] = []
    for raw_detection in output.detections:
        detection = dict(raw_detection)
        key = (
            str(detection.get("class_name", "")),
            str(detection["track_id"]) if detection.get("track_id") is not None else None,
        )
        detection["evidence_url"] = lookup.get(key)
        enriched.append(detection)
    return enriched


def _run_inference_uncached(
    video: ResolvedVideo,
    model_name: str,
    camera_code: str | None,
    user: dict[str, Any] | None,
) -> InferenceServiceResult:
    settings = get_settings()
    spec = registry.get_spec(model_name)
    context, persisted = _start_history(video, spec.name, camera_code, user)
    started_at = perf_counter()

    try:
        _, adapter = registry.get_adapter(spec.name)
        with _cache_lock:
            model_lock = _model_locks.setdefault(spec.name, Lock())
        with _inference_slots:
            with model_lock:
                output = adapter.infer(video.filepath, settings.output_dir)
        elapsed = perf_counter() - started_at
        output_video = (
            f"/results/{output.output_path.name}"
            if output.output_path is not None
            else f"/api/videos/{video.id}/stream"
        )

        event_ids: tuple[str, ...] = ()
        if context is not None:
            candidates = (
                _build_violation_candidates(
                    output, video, spec.name, output_video, context.inference_id,
                    context.camera_code,
                )
                if context.camera_id is not None
                else []
            )
            try:
                database.complete_inference(
                    inference_id=context.inference_id,
                    processing_time=elapsed,
                    output_video=output_video,
                    metrics=output.metrics,
                    predictions=output.predictions,
                    detections=_detections_with_evidence(output),
                )
            except Exception as exc:
                persisted = False
                logger.exception("Could not persist completed inference: %s", exc)
            else:
                if context.camera_id is not None and candidates:
                    try:
                        event_ids = tuple(
                            database.create_safety_events(
                                context.inference_id, context.camera_id, candidates
                            )
                        )
                        if len(event_ids) != len(candidates):
                            persisted = False
                            logger.error("Only %d/%d safety events persisted", len(event_ids), len(candidates))
                    except Exception:
                        persisted = False
                        logger.exception("Could not persist safety events")

        return InferenceServiceResult(
            inference_id=context.inference_id if context else None,
            model_name=spec.name,
            model_type=output.type,
            prediction=output.prediction,
            confidence=output.confidence,
            output_video=output_video,
            processing_time=elapsed,
            metrics=output.metrics,
            persisted=persisted,
            event_ids=event_ids,
        )
    except Exception as exc:
        elapsed = perf_counter() - started_at
        if context is not None:
            try:
                database.fail_inference(context.inference_id, elapsed, str(exc))
            except Exception:
                logger.exception("Could not persist failed inference")
        raise


def run_inference(
    video: ResolvedVideo,
    model_name: str,
    camera_code: str | None = None,
    user: dict[str, Any] | None = None,
) -> InferenceServiceResult:
    """Run once per video/model/camera and share the real result across clients."""
    spec = registry.get_spec(model_name)
    organization_scope = ",".join(sorted(str(value) for value in _organization_ids(user)))
    camera_scope = f"{organization_scope}:{(camera_code or '').upper()}"
    cache_key = (str(video.filepath.resolve()).lower(), spec.name, camera_scope)

    with _cache_lock:
        cached = _result_cache.get(cache_key)
        if cached is not None:
            return cached
        wait_event = _inflight.get(cache_key)
        is_leader = wait_event is None
        if is_leader:
            wait_event = Event()
            _inflight[cache_key] = wait_event
            _inference_errors.pop(cache_key, None)

    if not is_leader:
        wait_event.wait()
        with _cache_lock:
            cached = _result_cache.get(cache_key)
            if cached is not None:
                return cached
            message = _inference_errors.get(cache_key, "Inference failed")
        raise RuntimeError(message)

    try:
        result = _run_inference_uncached(video, spec.name, camera_code, user)
        if result.persisted:
            with _cache_lock:
                _result_cache[cache_key] = result
        return result
    except Exception as exc:
        with _cache_lock:
            _inference_errors[cache_key] = str(exc)
        raise
    finally:
        with _cache_lock:
            event = _inflight.pop(cache_key, None)
            if event is not None:
                event.set()

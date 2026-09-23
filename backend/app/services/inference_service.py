from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Lock
from time import perf_counter
from typing import Any

from app.config import get_settings
from app.database import database
from app.models.base import ModelNotConnectedError
from app.models.registry import registry
from app.services.video_catalog import ResolvedVideo

logger = logging.getLogger(__name__)


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


_cache_lock = Lock()
_result_cache: dict[tuple[str, str], InferenceServiceResult] = {}
_inflight: dict[tuple[str, str], Event] = {}
_inference_errors: dict[tuple[str, str], str] = {}
_model_locks: dict[str, Lock] = {}


def _start_history(video: ResolvedVideo, model_name: str) -> tuple[int | None, bool]:
    if not database.is_database_available():
        return None, False
    try:
        database.sync_models(registry.catalog_rows())
        database_video_id = database.get_video_id_by_path(video.filepath)
        if database_video_id is None:
            return None, False
        return database.create_inference(database_video_id, model_name), True
    except Exception as exc:
        logger.warning("Inference will run without PostgreSQL persistence: %s", exc)
        return None, False


def _run_inference_uncached(video: ResolvedVideo, model_name: str) -> InferenceServiceResult:
    settings = get_settings()
    spec = registry.get_spec(model_name)
    inference_id, persisted = _start_history(video, spec.name)
    started_at = perf_counter()

    try:
        _, adapter = registry.get_adapter(spec.name)
        with _cache_lock:
            model_lock = _model_locks.setdefault(spec.name, Lock())
        with model_lock:
            output = adapter.infer(video.filepath, settings.output_dir)
        elapsed = perf_counter() - started_at
        output_video = (
            f"/results/{output.output_path.name}"
            if output.output_path is not None
            else f"/api/videos/{video.id}/stream"
        )

        if inference_id is not None:
            try:
                database.complete_inference(
                    inference_id=inference_id,
                    processing_time=elapsed,
                    output_video=output_video,
                    predictions=output.predictions,
                    detections=output.detections,
                )
            except Exception as exc:
                persisted = False
                logger.exception("Could not persist completed inference: %s", exc)

        return InferenceServiceResult(
            inference_id=inference_id,
            model_name=spec.name,
            model_type=output.type,
            prediction=output.prediction,
            confidence=output.confidence,
            output_video=output_video,
            processing_time=elapsed,
            metrics=output.metrics,
            persisted=persisted,
        )
    except Exception as exc:
        elapsed = perf_counter() - started_at
        if inference_id is not None:
            try:
                database.fail_inference(inference_id, elapsed, str(exc))
            except Exception:
                logger.exception("Could not persist failed inference")
        raise


def run_inference(video: ResolvedVideo, model_name: str) -> InferenceServiceResult:
    """Run once per video/model and share the real result across dashboard clients."""
    spec = registry.get_spec(model_name)
    cache_key = (str(video.filepath.resolve()).lower(), spec.name)

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
        result = _run_inference_uncached(video, spec.name)
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

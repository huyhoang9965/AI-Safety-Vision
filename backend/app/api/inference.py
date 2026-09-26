from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import camera_viewer
from app.models.base import ModelNotConnectedError
from app.schemas import InferenceRequest, InferenceResponse
from app.services.inference_service import run_inference
from app.services.video_catalog import resolve_video

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/inference",
    tags=["inference"],
    dependencies=[Depends(camera_viewer)],
)


@router.post("", response_model=InferenceResponse)
def create_inference(
    payload: InferenceRequest,
    user: Annotated[dict, Depends(camera_viewer)],
) -> InferenceResponse:
    video = resolve_video(payload.video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Test video not found")
    if not video.filepath.is_file():
        raise HTTPException(status_code=404, detail=f"Video file is missing: {video.filename}")

    try:
        result = run_inference(
            video,
            payload.model_name,
            camera_code=payload.camera_code,
            user=user,
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ModelNotConnectedError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "message": ModelNotConnectedError.public_message,
                "model": payload.model_name,
                "reason": exc.reason,
            },
        ) from exc
    except Exception as exc:
        logger.exception("Inference failed for %s using %s", video.filename, payload.model_name)
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    return InferenceResponse(
        inference_id=result.inference_id,
        video=video.filename,
        video_id=video.id,
        model=result.model_name,
        type=result.model_type,
        prediction=result.prediction,
        confidence=result.confidence,
        output_video=result.output_video,
        processing_time=result.processing_time,
        metrics=result.metrics,
        ground_truth=list(video.labels),
        persisted=result.persisted,
        event_ids=list(result.event_ids),
        violations_saved=len(result.event_ids),
    )

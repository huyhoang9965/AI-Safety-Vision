from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class VideoItem(BaseModel):
    id: int
    filename: str
    path: str
    labels: list[str]
    split: Literal["test"] = "test"
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    stream_url: str


class ModelItem(BaseModel):
    name: str
    type: Literal["detection", "classification"]
    version: str
    connected: bool
    loaded: bool
    status: str
    weight_path: str | None = None


class InferenceRequest(BaseModel):
    video_id: int = Field(gt=0)
    model_name: str = Field(min_length=1, max_length=100)
    camera_code: str | None = Field(
        default=None,
        min_length=1,
        max_length=60,
        pattern=r"^[A-Za-z0-9_-]+$",
    )


class InferenceResponse(BaseModel):
    inference_id: int | None = None
    video: str
    video_id: int
    model: str
    type: Literal["detection", "classification"]
    prediction: str
    confidence: float
    output_video: str
    processing_time: float
    metrics: dict[str, Any]
    ground_truth: list[str]
    persisted: bool
    event_ids: list[str] = Field(default_factory=list)
    violations_saved: int = 0

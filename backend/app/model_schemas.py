from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ModelRunStats(BaseModel):
    total_runs: int
    completed_runs: int
    failed_runs: int
    average_processing_seconds: float | None
    last_run_at: datetime | None
    detections: int
    violations: int
    average_confidence: float | None


class ManagedModel(BaseModel):
    code: str
    name: str
    version: str
    type: Literal["detection", "classification"]
    framework: str
    connected: bool
    loaded: bool
    status: str
    artifact_name: str | None
    artifact_size_bytes: int | None
    labels: list[str]
    active_deployments: int
    camera_coverage: int
    stats: ModelRunStats


class ModelDeploymentItem(BaseModel):
    id: UUID
    model_code: str
    model_name: str
    camera_id: UUID
    camera_code: str
    camera_name: str
    site_name: str
    zone_name: str | None
    confidence_threshold: float
    is_enabled: bool
    deployed_at: datetime
    stopped_at: datetime | None


class ModelCameraOption(BaseModel):
    id: UUID
    code: str
    name: str
    site_name: str
    zone_name: str | None
    status: str


class RecentInference(BaseModel):
    id: int
    model_name: str
    camera_code: str | None
    status: str
    processing_time: float | None
    prediction: str | None
    confidence: float | None
    created_at: datetime


class ModelClassMetric(BaseModel):
    model_name: str
    class_name: str
    count: int
    average_confidence: float


class ModelDailyMetric(BaseModel):
    day: str
    model_name: str
    completed: int
    failed: int
    average_processing_seconds: float | None


class ModelManagementSummary(BaseModel):
    total_models: int
    connected_models: int
    loaded_models: int
    active_deployments: int
    cameras_covered: int
    runs_24h: int
    failures_24h: int
    average_processing_seconds: float | None


class ModelManagementResponse(BaseModel):
    models: list[ManagedModel]
    deployments: list[ModelDeploymentItem]
    cameras: list[ModelCameraOption]
    recent_inferences: list[RecentInference]
    class_metrics: list[ModelClassMetric]
    daily_metrics: list[ModelDailyMetric]
    summary: ModelManagementSummary


class ModelDeployRequest(BaseModel):
    camera_ids: list[UUID] = Field(min_length=1, max_length=100)
    confidence_threshold: float = Field(ge=0.1, le=0.99)


class DeploymentStatusRequest(BaseModel):
    is_enabled: bool


class DeploymentThresholdRequest(BaseModel):
    confidence_threshold: float = Field(ge=0.1, le=0.99)


class ModelActionResponse(BaseModel):
    success: bool
    message: str
    affected: int = 0

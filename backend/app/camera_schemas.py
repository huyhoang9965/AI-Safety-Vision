from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


DeviceStatus = Literal["online", "offline", "warning", "maintenance", "disabled"]


class SiteItem(BaseModel):
    id: UUID
    code: str
    name: str
    address: str | None
    latitude: float | None
    longitude: float | None
    timezone: str
    is_active: bool
    zone_count: int
    camera_count: int


class ZoneItem(BaseModel):
    id: UUID
    site_id: UUID
    site_code: str
    code: str
    name: str
    description: str | None
    is_restricted: bool
    is_active: bool
    camera_count: int


class CameraItem(BaseModel):
    id: UUID
    site_id: UUID
    zone_id: UUID | None
    site_code: str
    site_name: str
    zone_code: str | None
    zone_name: str | None
    code: str
    name: str
    snapshot_url: str | None
    status: DeviceStatus
    manufacturer: str | None
    model: str | None
    ip_address: str | None
    latitude: float | None
    longitude: float | None
    fps: float | None
    resolution_width: int | None
    resolution_height: int | None
    installed_at: date | None
    last_seen_at: datetime | None
    stream_configured: bool
    is_active: bool
    deployment_count: int
    health_status: DeviceStatus | None
    latest_latency_ms: int | None
    latest_packet_loss_pct: float | None
    updated_at: datetime


class InfrastructureSummary(BaseModel):
    sites: int
    zones: int
    cameras: int
    online: int
    offline: int
    warning: int
    maintenance: int
    disabled: int
    restricted_zones: int


class InfrastructureResponse(BaseModel):
    sites: list[SiteItem]
    zones: list[ZoneItem]
    cameras: list[CameraItem]
    summary: InfrastructureSummary


class HealthSample(BaseModel):
    id: int
    status: DeviceStatus
    latency_ms: int | None
    fps: float | None
    packet_loss_pct: float | None
    cpu_usage_pct: float | None
    gpu_usage_pct: float | None
    temperature_c: float | None
    sampled_at: datetime


class ModelDeployment(BaseModel):
    id: UUID
    model_code: str
    model_name: str
    version: str
    confidence_threshold: float
    is_enabled: bool
    deployed_at: datetime


class CameraDetail(CameraItem):
    health_samples: list[HealthSample]
    deployments: list[ModelDeployment]
    events_24h: int
    events_7d: int


class SiteCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=200)
    address: str | None = Field(default=None, max_length=1000)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    timezone: str = Field(default="Asia/Ho_Chi_Minh", min_length=1, max_length=60)
    is_active: bool = True


class ZoneCreateRequest(BaseModel):
    site_id: UUID
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=2000)
    is_restricted: bool = False
    is_active: bool = True


class CameraCreateRequest(BaseModel):
    site_id: UUID
    zone_id: UUID | None = None
    code: str = Field(min_length=1, max_length=60, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=2, max_length=150)
    snapshot_url: str | None = Field(default=None, max_length=2000)
    status: DeviceStatus = "offline"
    manufacturer: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=100)
    ip_address: str | None = Field(default=None, max_length=45)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    fps: float | None = Field(default=None, gt=0, le=240)
    resolution_width: int | None = Field(default=None, gt=0, le=16384)
    resolution_height: int | None = Field(default=None, gt=0, le=16384)
    installed_at: date | None = None
    is_active: bool = True


class CameraStatusRequest(BaseModel):
    status: DeviceStatus


class ActionResponse(BaseModel):
    success: bool
    message: str

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


Severity = Literal["low", "medium", "high", "critical"]
EventStatus = Literal["new", "acknowledged", "resolved", "dismissed"]


class AlertActor(BaseModel):
    id: UUID
    full_name: str


class AlertItem(BaseModel):
    id: UUID
    event_code: str
    event_name: str
    title: str
    description: str | None
    severity: Severity
    status: EventStatus
    confidence: float | None
    object_count: int
    detected_at: datetime
    acknowledged_at: datetime | None
    resolved_at: datetime | None
    resolution_note: str | None
    site_code: str
    site_name: str
    zone_code: str | None
    zone_name: str | None
    camera_code: str
    camera_name: str
    snapshot_url: str | None
    video_url: str | None
    thumbnail_url: str | None
    acknowledged_by: AlertActor | None
    resolved_by: AlertActor | None
    incident_id: UUID | None


class AlertSummary(BaseModel):
    total: int
    new: int
    acknowledged: int
    resolved: int
    dismissed: int
    critical_open: int
    high_open: int
    today: int
    average_acknowledge_seconds: float | None


class AlertFilterOption(BaseModel):
    code: str
    name: str


class AlertFilters(BaseModel):
    event_types: list[AlertFilterOption]
    sites: list[AlertFilterOption]
    cameras: list[AlertFilterOption]


class AlertListResponse(BaseModel):
    items: list[AlertItem]
    total: int
    limit: int
    offset: int
    summary: AlertSummary
    filters: AlertFilters


class AlertActionRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class AlertIncidentRequest(BaseModel):
    title: str | None = Field(default=None, max_length=250)


class AlertActionResponse(BaseModel):
    success: bool
    message: str
    alert: AlertItem | None = None
    incident_id: UUID | None = None

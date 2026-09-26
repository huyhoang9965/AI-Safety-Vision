from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


Severity = Literal["low", "medium", "high", "critical"]
EventStatus = Literal["new", "acknowledged", "resolved", "dismissed"]


class ReportPeriod(BaseModel):
    days: int
    start_at: datetime
    end_at: datetime
    previous_start_at: datetime


class ReportSummary(BaseModel):
    total_events: int
    previous_events: int
    event_change_percent: float | None
    critical_events: int
    critical_change_percent: float | None
    open_events: int
    resolved_events: int
    resolution_rate: float
    average_acknowledge_seconds: float | None
    average_resolution_seconds: float | None
    average_confidence: float | None
    incidents: int
    overdue_incidents: int
    reporting_cameras: int


class ReportTrendPoint(BaseModel):
    day: date
    total: int
    critical: int
    resolved: int
    incidents: int


class ReportEventTypeMetric(BaseModel):
    code: str
    name: str
    color: str | None
    total: int
    previous_total: int
    change_percent: float | None
    average_confidence: float | None


class ReportNamedMetric(BaseModel):
    key: str
    label: str
    total: int
    percentage: float


class ReportSiteMetric(BaseModel):
    code: str
    name: str
    total: int
    critical: int
    open_events: int
    resolved: int
    resolution_rate: float
    cameras: int


class ReportCameraMetric(BaseModel):
    code: str
    name: str
    site_name: str
    zone_name: str | None
    status: str
    total: int
    critical: int
    average_confidence: float | None


class ReportHeatmapCell(BaseModel):
    weekday: int
    hour: int
    total: int


class ReportRecentEvent(BaseModel):
    id: UUID
    title: str
    event_code: str
    event_name: str
    severity: Severity
    status: EventStatus
    confidence: float | None
    detected_at: datetime
    site_name: str
    zone_name: str | None
    camera_code: str
    camera_name: str
    snapshot_url: str | None


class ReportFilterOption(BaseModel):
    code: str
    name: str


class ReportFilters(BaseModel):
    sites: list[ReportFilterOption]


class ReportOverviewResponse(BaseModel):
    period: ReportPeriod
    summary: ReportSummary
    trend: list[ReportTrendPoint]
    event_types: list[ReportEventTypeMetric]
    severities: list[ReportNamedMetric]
    statuses: list[ReportNamedMetric]
    sites: list[ReportSiteMetric]
    cameras: list[ReportCameraMetric]
    heatmap: list[ReportHeatmapCell]
    recent_events: list[ReportRecentEvent]
    filters: ReportFilters
    generated_at: datetime

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


Severity = Literal["low", "medium", "high", "critical"]
IncidentStatus = Literal["open", "investigating", "resolved", "closed"]


class IncidentUser(BaseModel):
    id: UUID
    full_name: str
    email: str | None = None


class IncidentItem(BaseModel):
    id: UUID
    incident_no: int
    title: str
    description: str | None
    severity: Severity
    status: IncidentStatus
    site_code: str
    site_name: str
    assigned_to: IncidentUser | None
    opened_by: IncidentUser | None
    opened_at: datetime
    due_at: datetime | None
    resolved_at: datetime | None
    closed_at: datetime | None
    updated_at: datetime
    event_count: int
    comment_count: int
    overdue: bool


class IncidentSummary(BaseModel):
    total: int
    open: int
    investigating: int
    resolved: int
    closed: int
    overdue: int
    critical_open: int
    unassigned: int
    average_resolution_seconds: float | None


class IncidentOption(BaseModel):
    code: str
    name: str


class IncidentMember(BaseModel):
    id: UUID
    full_name: str
    email: str


class IncidentFilters(BaseModel):
    sites: list[IncidentOption]
    members: list[IncidentMember]


class IncidentListResponse(BaseModel):
    items: list[IncidentItem]
    total: int
    limit: int
    offset: int
    summary: IncidentSummary
    filters: IncidentFilters


class IncidentComment(BaseModel):
    id: UUID
    body: str
    created_at: datetime
    updated_at: datetime
    user: IncidentUser | None


class IncidentHistory(BaseModel):
    id: int
    old_status: IncidentStatus | None
    new_status: IncidentStatus
    note: str | None
    changed_at: datetime
    changed_by: IncidentUser | None


class IncidentLinkedEvent(BaseModel):
    id: UUID
    title: str
    severity: Severity
    status: str
    detected_at: datetime
    event_name: str
    camera_code: str
    camera_name: str
    snapshot_url: str | None


class IncidentDetail(IncidentItem):
    resolution: str | None
    root_cause: str | None
    corrective_action: str | None
    comments: list[IncidentComment]
    history: list[IncidentHistory]
    linked_events: list[IncidentLinkedEvent]


class IncidentCreateRequest(BaseModel):
    site_code: str = Field(min_length=1, max_length=50)
    title: str = Field(min_length=3, max_length=250)
    description: str | None = Field(default=None, max_length=5000)
    severity: Severity = "medium"
    assigned_to: UUID | None = None
    due_at: datetime | None = None


class IncidentUpdateRequest(BaseModel):
    title: str = Field(min_length=3, max_length=250)
    description: str | None = Field(default=None, max_length=5000)
    severity: Severity
    assigned_to: UUID | None = None
    due_at: datetime | None = None
    root_cause: str | None = Field(default=None, max_length=5000)
    corrective_action: str | None = Field(default=None, max_length=5000)
    resolution: str | None = Field(default=None, max_length=5000)


class IncidentStatusRequest(BaseModel):
    status: IncidentStatus
    note: str | None = Field(default=None, max_length=2000)


class IncidentCommentRequest(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


class IncidentActionResponse(BaseModel):
    success: bool
    message: str
    incident: IncidentDetail

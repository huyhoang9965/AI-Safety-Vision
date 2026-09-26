from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.auth import require_permission
from app.incident_schemas import (
    IncidentActionResponse,
    IncidentCommentRequest,
    IncidentCreateRequest,
    IncidentDetail,
    IncidentListResponse,
    IncidentStatusRequest,
    IncidentUpdateRequest,
)
from app.services import incident_service
from app.services.incident_service import IncidentConflictError, IncidentNotFoundError


router = APIRouter(prefix="/api/incidents", tags=["incidents"])
incident_viewer = require_permission("incident.view")
incident_manager = require_permission("incident.manage")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, IncidentNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, (IncidentConflictError, ValueError)):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Không thể cập nhật dữ liệu sự cố",
    )


@router.get("", response_model=IncidentListResponse)
def incidents(
    user: Annotated[dict, Depends(incident_viewer)],
    status_filter: Annotated[
        Literal["open", "investigating", "resolved", "closed"] | None,
        Query(alias="status"),
    ] = None,
    severity: Literal["low", "medium", "high", "critical"] | None = None,
    site: str | None = Query(default=None, max_length=50),
    assignee: str | None = Query(default=None, max_length=50),
    search: str | None = Query(default=None, max_length=200),
    period: Literal["all", "today", "7d", "30d", "90d"] = "30d",
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> IncidentListResponse:
    try:
        payload = incident_service.list_incidents(
            user, status_filter, severity, site, assignee,
            search, period, limit, offset,
        )
        return IncidentListResponse(**payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể tải danh sách sự cố",
        ) from exc


@router.get("/{incident_id}", response_model=IncidentDetail)
def detail(
    incident_id: UUID,
    user: Annotated[dict, Depends(incident_viewer)],
) -> IncidentDetail:
    try:
        return IncidentDetail(**incident_service.detail(incident_id, user))
    except Exception as exc:
        raise _error(exc) from exc


@router.post("", response_model=IncidentActionResponse, status_code=status.HTTP_201_CREATED)
def create(
    body: IncidentCreateRequest,
    user: Annotated[dict, Depends(incident_manager)],
) -> IncidentActionResponse:
    try:
        incident = incident_service.create(body, user)
        return IncidentActionResponse(
            success=True, message="Đã tạo sự cố", incident=incident,
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{incident_id}/update", response_model=IncidentActionResponse)
def update(
    incident_id: UUID,
    body: IncidentUpdateRequest,
    user: Annotated[dict, Depends(incident_manager)],
) -> IncidentActionResponse:
    try:
        incident = incident_service.update(incident_id, body, user)
        return IncidentActionResponse(
            success=True, message="Đã cập nhật hồ sơ sự cố", incident=incident,
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{incident_id}/status", response_model=IncidentActionResponse)
def change_status(
    incident_id: UUID,
    body: IncidentStatusRequest,
    user: Annotated[dict, Depends(incident_manager)],
) -> IncidentActionResponse:
    try:
        incident = incident_service.change_status(
            incident_id, body.status, body.note, user,
        )
        return IncidentActionResponse(
            success=True, message="Đã cập nhật trạng thái sự cố", incident=incident,
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{incident_id}/comments", response_model=IncidentActionResponse)
def comment(
    incident_id: UUID,
    body: IncidentCommentRequest,
    user: Annotated[dict, Depends(incident_manager)],
) -> IncidentActionResponse:
    try:
        incident = incident_service.add_comment(incident_id, body.body, user)
        return IncidentActionResponse(
            success=True, message="Đã thêm bình luận", incident=incident,
        )
    except Exception as exc:
        raise _error(exc) from exc

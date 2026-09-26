from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.alert_schemas import (
    AlertActionRequest,
    AlertActionResponse,
    AlertIncidentRequest,
    AlertListResponse,
)
from app.api.auth import require_permission
from app.services import alert_service
from app.services.alert_service import AlertConflictError, AlertNotFoundError


router = APIRouter(prefix="/api/alerts", tags=["alerts"])
event_viewer = require_permission("event.view")
event_acknowledger = require_permission("event.acknowledge")
event_resolver = require_permission("event.resolve")
incident_manager = require_permission("incident.manage")


@router.get("", response_model=AlertListResponse)
def alerts(
    user: Annotated[dict, Depends(event_viewer)],
    status_filter: Annotated[
        Literal["new", "acknowledged", "resolved", "dismissed"] | None,
        Query(alias="status"),
    ] = None,
    severity: Literal["low", "medium", "high", "critical"] | None = None,
    event_type: str | None = Query(default=None, max_length=80),
    site: str | None = Query(default=None, max_length=50),
    camera: str | None = Query(default=None, max_length=60),
    search: str | None = Query(default=None, max_length=200),
    period: Literal["all", "today", "24h", "7d", "30d"] = "24h",
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> AlertListResponse:
    try:
        payload = alert_service.list_alerts(
            user,
            status_filter,
            severity,
            event_type,
            site,
            camera,
            search,
            period,
            limit,
            offset,
        )
        return AlertListResponse(**payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể tải dữ liệu cảnh báo",
        ) from exc


def _action_error(exc: Exception) -> HTTPException:
    if isinstance(exc, AlertNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, AlertConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Không thể cập nhật cảnh báo",
    )


@router.post("/{event_id}/acknowledge", response_model=AlertActionResponse)
def acknowledge(
    event_id: UUID,
    body: AlertActionRequest,
    user: Annotated[dict, Depends(event_acknowledger)],
) -> AlertActionResponse:
    try:
        alert = alert_service.acknowledge(event_id, user, body.note)
        return AlertActionResponse(
            success=True,
            message="Đã xác nhận cảnh báo",
            alert=alert,
        )
    except Exception as exc:
        raise _action_error(exc) from exc


@router.post("/{event_id}/resolve", response_model=AlertActionResponse)
def resolve(
    event_id: UUID,
    body: AlertActionRequest,
    user: Annotated[dict, Depends(event_resolver)],
) -> AlertActionResponse:
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Vui lòng nhập ghi chú xử lý",
        )
    try:
        alert = alert_service.resolve(event_id, user, note)
        return AlertActionResponse(
            success=True,
            message="Đã đóng cảnh báo",
            alert=alert,
        )
    except Exception as exc:
        raise _action_error(exc) from exc


@router.post("/{event_id}/dismiss", response_model=AlertActionResponse)
def dismiss(
    event_id: UUID,
    body: AlertActionRequest,
    user: Annotated[dict, Depends(event_resolver)],
) -> AlertActionResponse:
    note = (body.note or "").strip()
    if not note:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Vui lòng nhập lý do loại bỏ cảnh báo",
        )
    try:
        alert = alert_service.dismiss(event_id, user, note)
        return AlertActionResponse(
            success=True,
            message="Đã đánh dấu cảnh báo sai",
            alert=alert,
        )
    except Exception as exc:
        raise _action_error(exc) from exc


@router.post("/{event_id}/incident", response_model=AlertActionResponse)
def incident(
    event_id: UUID,
    body: AlertIncidentRequest,
    user: Annotated[dict, Depends(incident_manager)],
) -> AlertActionResponse:
    try:
        incident_id = alert_service.create_incident(event_id, user, body.title)
        return AlertActionResponse(
            success=True,
            message="Đã tạo phiếu sự cố",
            incident_id=incident_id,
        )
    except Exception as exc:
        raise _action_error(exc) from exc

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.auth import require_permission
from app.camera_schemas import (
    ActionResponse, CameraCreateRequest, CameraDetail, CameraStatusRequest,
    InfrastructureResponse, SiteCreateRequest, ZoneCreateRequest,
)
from app.services import camera_service
from app.services.camera_service import InfrastructureConflictError, InfrastructureNotFoundError


router = APIRouter(prefix="/api/infrastructure", tags=["camera-infrastructure"])
camera_viewer = require_permission("camera.view")
camera_manager = require_permission("camera.manage")
site_manager = require_permission("site.manage")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, InfrastructureNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, (InfrastructureConflictError, ValueError)):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Không thể cập nhật hạ tầng camera")


@router.get("", response_model=InfrastructureResponse)
def infrastructure(user: Annotated[dict, Depends(camera_viewer)]) -> InfrastructureResponse:
    try:
        return InfrastructureResponse(**camera_service.list_infrastructure(user))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Không thể tải dữ liệu camera") from exc


@router.get("/cameras/{camera_id}", response_model=CameraDetail)
def camera_detail(camera_id: UUID, user: Annotated[dict, Depends(camera_viewer)]) -> CameraDetail:
    try:
        return CameraDetail(**camera_service.camera_detail(camera_id, user))
    except Exception as exc:
        raise _error(exc) from exc
@router.post("/sites", response_model=ActionResponse, status_code=status.HTTP_201_CREATED)
def create_site(body: SiteCreateRequest, user: Annotated[dict, Depends(site_manager)]) -> ActionResponse:
    try:
        camera_service.create_site(body, user)
        return ActionResponse(success=True, message="Đã tạo nhà máy")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/sites/{site_id}/update", response_model=ActionResponse)
def update_site(site_id: UUID, body: SiteCreateRequest, user: Annotated[dict, Depends(site_manager)]) -> ActionResponse:
    try:
        camera_service.update_site(site_id, body, user)
        return ActionResponse(success=True, message="Đã cập nhật nhà máy")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/zones", response_model=ActionResponse, status_code=status.HTTP_201_CREATED)
def create_zone(body: ZoneCreateRequest, user: Annotated[dict, Depends(site_manager)]) -> ActionResponse:
    try:
        camera_service.create_zone(body, user)
        return ActionResponse(success=True, message="Đã tạo khu vực")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/zones/{zone_id}/update", response_model=ActionResponse)
def update_zone(zone_id: UUID, body: ZoneCreateRequest, user: Annotated[dict, Depends(site_manager)]) -> ActionResponse:
    try:
        camera_service.update_zone(zone_id, body, user)
        return ActionResponse(success=True, message="Đã cập nhật khu vực")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/cameras", response_model=ActionResponse, status_code=status.HTTP_201_CREATED)
def create_camera(body: CameraCreateRequest, user: Annotated[dict, Depends(camera_manager)]) -> ActionResponse:
    try:
        camera_service.create_camera(body, user)
        return ActionResponse(success=True, message="Đã thêm camera")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/cameras/{camera_id}/update", response_model=ActionResponse)
def update_camera(camera_id: UUID, body: CameraCreateRequest, user: Annotated[dict, Depends(camera_manager)]) -> ActionResponse:
    try:
        camera_service.update_camera(camera_id, body, user)
        return ActionResponse(success=True, message="Đã cập nhật camera")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/cameras/{camera_id}/status", response_model=ActionResponse)
def update_camera_status(camera_id: UUID, body: CameraStatusRequest, user: Annotated[dict, Depends(camera_manager)]) -> ActionResponse:
    try:
        camera_service.update_camera_status(camera_id, body.status, user)
        return ActionResponse(success=True, message="Đã cập nhật trạng thái camera")
    except Exception as exc:
        raise _error(exc) from exc


from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.auth import require_permission
from app.services import settings_service
from app.services.settings_service import SettingsNotFoundError
from app.settings_schemas import (
    SettingsActionResponse,
    SystemSettingsPayload,
    SystemSettingsResponse,
)


router = APIRouter(prefix="/api/settings", tags=["system-settings"])
settings_manager = require_permission("settings.manage")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, SettingsNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Không thể cập nhật cấu hình hệ thống",
    )


@router.get("", response_model=SystemSettingsResponse)
def settings(
    user: Annotated[dict, Depends(settings_manager)],
) -> SystemSettingsResponse:
    try:
        return SystemSettingsResponse(**settings_service.get_settings(user))
    except Exception as exc:
        raise _error(exc) from exc


@router.post("", response_model=SettingsActionResponse)
def update_settings(
    body: SystemSettingsPayload,
    user: Annotated[dict, Depends(settings_manager)],
) -> SettingsActionResponse:
    try:
        payload = settings_service.update_settings(body, user)
        return SettingsActionResponse(
            success=True,
            message="Đã lưu cấu hình hệ thống",
            settings=SystemSettingsResponse(**payload),
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/reset", response_model=SettingsActionResponse)
def reset_settings(
    user: Annotated[dict, Depends(settings_manager)],
) -> SettingsActionResponse:
    try:
        payload = settings_service.reset_settings(user)
        return SettingsActionResponse(
            success=True,
            message="Đã khôi phục cấu hình mặc định",
            settings=SystemSettingsResponse(**payload),
        )
    except Exception as exc:
        raise _error(exc) from exc

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.auth import require_permission
from app.user_schemas import (
    ManagedUserDetail, PasswordResetRequest, UserActionResponse, UserCreateRequest,
    UserManagementResponse, UserStatusRequest, UserUpdateRequest,
)
from app.services import user_service
from app.services.user_service import UserConflictError, UserNotFoundError


router = APIRouter(prefix="/api/users", tags=["user-management"])
user_viewer = require_permission("user.view")
user_manager = require_permission("user.manage")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, UserNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, (UserConflictError, ValueError)):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=503, detail="Không thể cập nhật dữ liệu người dùng")


@router.get("", response_model=UserManagementResponse)
def users(user: Annotated[dict, Depends(user_viewer)]) -> UserManagementResponse:
    try:
        return UserManagementResponse(**user_service.list_users(user))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Không thể tải danh sách người dùng") from exc


@router.get("/{user_id}", response_model=ManagedUserDetail)
def user_detail(user_id: UUID, user: Annotated[dict, Depends(user_viewer)]) -> ManagedUserDetail:
    try:
        return ManagedUserDetail(**user_service.user_detail(user_id, user))
    except Exception as exc:
        raise _error(exc) from exc
@router.post("", response_model=UserActionResponse, status_code=status.HTTP_201_CREATED)
def create(body: UserCreateRequest, user: Annotated[dict, Depends(user_manager)]) -> UserActionResponse:
    try:
        user_id = user_service.create_user(body, user)
        return UserActionResponse(success=True, message="Đã tạo tài khoản", user_id=user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{user_id}/update", response_model=UserActionResponse)
def update(user_id: UUID, body: UserUpdateRequest, user: Annotated[dict, Depends(user_manager)]) -> UserActionResponse:
    try:
        user_service.update_user(user_id, body, user)
        return UserActionResponse(success=True, message="Đã cập nhật người dùng và phân quyền", user_id=user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{user_id}/status", response_model=UserActionResponse)
def change_status(user_id: UUID, body: UserStatusRequest, user: Annotated[dict, Depends(user_manager)]) -> UserActionResponse:
    try:
        user_service.change_status(user_id, body.status, user)
        return UserActionResponse(success=True, message="Đã cập nhật trạng thái tài khoản", user_id=user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{user_id}/reset-password", response_model=UserActionResponse)
def reset_password(user_id: UUID, body: PasswordResetRequest, user: Annotated[dict, Depends(user_manager)]) -> UserActionResponse:
    try:
        user_service.reset_password(user_id, body.temporary_password.get_secret_value(), user)
        return UserActionResponse(success=True, message="Đã đặt mật khẩu tạm và thu hồi các phiên cũ", user_id=user_id)
    except Exception as exc:
        raise _error(exc) from exc


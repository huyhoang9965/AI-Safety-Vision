from __future__ import annotations

from ipaddress import ip_address
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth_schemas import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    RegisterResponse,
    TokenResponse,
    UserResponse,
)
from app.security import TokenError, decode_access_token
from app.services import auth_service
from app.services.auth_service import AuthenticationError, RegistrationError


router = APIRouter(prefix="/api/auth", tags=["authentication"])
bearer_scheme = HTTPBearer(auto_error=False)


def _client_context(request: Request) -> tuple[str | None, str | None]:
    forwarded = request.headers.get("x-forwarded-for")
    candidate = forwarded.split(",", 1)[0].strip() if forwarded else None
    if not candidate and request.client:
        candidate = request.client.host
    try:
        valid_ip = str(ip_address(candidate)) if candidate else None
    except ValueError:
        valid_ip = None
    return valid_ip, request.headers.get("user-agent")


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> dict[str, Any]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Thiếu access token")
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = UUID(payload["sub"])
    except (TokenError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    user = auth_service.get_user(user_id)
    if user is None or user["status"] != "active":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Tài khoản không còn hoạt động",
        )
    return user


def require_permission(permission_code: str):
    def permission_guard(
        user: Annotated[dict[str, Any], Depends(current_user)],
    ) -> dict[str, Any]:
        allowed = any(
            permission_code in membership.get("permissions", [])
            for membership in user.get("memberships", [])
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tài khoản không có quyền thực hiện thao tác này",
            )
        return user

    return permission_guard


camera_viewer = require_permission("camera.view")
dashboard_viewer = require_permission("dashboard.view")


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest) -> RegisterResponse:
    try:
        user = auth_service.register_user(body)
    except RegistrationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể kết nối dịch vụ tài khoản",
        ) from exc

    message = "Đăng ký thành công"
    if user["status"] == "pending":
        message = "Đăng ký thành công. Vui lòng xác thực email"
    return RegisterResponse(user=user, message=message)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request) -> TokenResponse:
    ip_address, user_agent = _client_context(request)
    try:
        result = auth_service.login_user(
            body.email,
            body.password.get_secret_value(),
            ip_address,
            user_agent,
        )
    except AuthenticationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể kết nối dịch vụ tài khoản",
        ) from exc
    return TokenResponse(**result)


@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, request: Request) -> TokenResponse:
    ip_address, user_agent = _client_context(request)
    try:
        result = auth_service.refresh_session(body.refresh_token, ip_address, user_agent)
    except AuthenticationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể làm mới phiên đăng nhập",
        ) from exc
    return TokenResponse(**result)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    response_model=None,
)
def logout(body: LogoutRequest) -> None:
    try:
        auth_service.logout_session(body.refresh_token)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Không thể đăng xuất",
        ) from exc


@router.get("/me", response_model=UserResponse)
def me(user: Annotated[dict[str, Any], Depends(current_user)]) -> UserResponse:
    return UserResponse(**user)

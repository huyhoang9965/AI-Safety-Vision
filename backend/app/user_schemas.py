from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, field_validator


UserStatus = Literal["pending", "active", "locked", "disabled"]


class PermissionItem(BaseModel):
    id: UUID
    code: str
    name: str
    description: str | None


class RoleItem(BaseModel):
    id: UUID
    code: str
    name: str
    description: str | None
    is_system: bool
    permissions: list[str]
    member_count: int


class SiteOption(BaseModel):
    id: UUID
    code: str
    name: str


class ManagedUser(BaseModel):
    id: UUID
    email: str
    username: str | None
    full_name: str
    department: str | None
    job_title: str | None
    phone: str | None
    avatar_url: str | None
    status: UserStatus
    email_verified: bool
    last_login_at: datetime | None
    failed_login_count: int
    locked_until: datetime | None
    created_at: datetime
    role_id: UUID
    role_code: str
    role_name: str
    permissions: list[str]
    site_ids: list[UUID]
    site_count: int
    active_sessions: int
    must_change_password: bool


class UserSummary(BaseModel):
    total: int
    active: int
    pending: int
    locked: int
    disabled: int
    admins: int
    active_sessions: int


class UserManagementResponse(BaseModel):
    users: list[ManagedUser]
    roles: list[RoleItem]
    permissions: list[PermissionItem]
    sites: list[SiteOption]
    summary: UserSummary
    organization_name: str


class LoginActivity(BaseModel):
    id: int
    succeeded: bool
    failure_reason: str | None
    ip_address: str | None
    user_agent: str | None
    attempted_at: datetime


class AuditActivity(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: str | None
    created_at: datetime
    actor_name: str | None


class SessionItem(BaseModel):
    id: UUID
    ip_address: str | None
    user_agent: str | None
    device_name: str | None
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime


class ManagedUserDetail(ManagedUser):
    login_activity: list[LoginActivity]
    audit_activity: list[AuditActivity]
    sessions: list[SessionItem]


class UserCreateRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    temporary_password: SecretStr = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=150)
    username: str | None = Field(default=None, min_length=3, max_length=60)
    department: str | None = Field(default=None, max_length=150)
    job_title: str | None = Field(default=None, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    role_id: UUID
    site_ids: list[UUID] = Field(default_factory=list)
    status: UserStatus = "active"

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.fullmatch(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", normalized, re.I):
            raise ValueError("Email không hợp lệ")
        return normalized


class UserUpdateRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    full_name: str = Field(min_length=2, max_length=150)
    username: str | None = Field(default=None, min_length=3, max_length=60)
    department: str | None = Field(default=None, max_length=150)
    job_title: str | None = Field(default=None, max_length=150)
    phone: str | None = Field(default=None, max_length=30)
    role_id: UUID
    site_ids: list[UUID] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.fullmatch(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", normalized, re.I):
            raise ValueError("Email không hợp lệ")
        return normalized


class UserStatusRequest(BaseModel):
    status: UserStatus


class PasswordResetRequest(BaseModel):
    temporary_password: SecretStr = Field(min_length=8, max_length=128)


class UserActionResponse(BaseModel):
    success: bool
    message: str
    user_id: UUID

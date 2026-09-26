from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, field_validator


class RegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: SecretStr = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=150)
    username: str | None = Field(default=None, min_length=3, max_length=60)
    department: str | None = Field(default=None, max_length=150)
    job_title: str | None = Field(default=None, max_length=150)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("full_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.strip()


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: SecretStr = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=32, max_length=500)


class LogoutRequest(RefreshRequest):
    pass


class MembershipResponse(BaseModel):
    organization_id: UUID
    organization_code: str
    organization_name: str
    role_code: str
    role_name: str
    is_default: bool
    permissions: list[str]


class UserResponse(BaseModel):
    id: UUID
    email: str
    username: str | None
    full_name: str
    department: str | None
    job_title: str | None
    phone: str | None
    avatar_url: str | None
    status: str
    email_verified: bool
    memberships: list[MembershipResponse] = Field(default_factory=list)


class RegisterResponse(BaseModel):
    user: UserResponse
    message: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse

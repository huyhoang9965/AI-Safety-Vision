from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class UpdateProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    full_name: str = Field(min_length=2, max_length=150)
    username: str | None = Field(default=None, min_length=3, max_length=60)
    phone: str | None = Field(default=None, max_length=30)
    department: str | None = Field(default=None, max_length=150)
    job_title: str | None = Field(default=None, max_length=150)
    birthday: date | None = None
    gender: Literal["male", "female", "other", "undisclosed"] | None = None
    bio: str = Field(default="", max_length=200)
    avatar_data: str | None = Field(default=None, max_length=7_000_000)
    remove_avatar: bool = False

    @field_validator("full_name", "username", "phone", "department", "job_title", "bio", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("username", "phone", "department", "job_title", mode="before")
    @classmethod
    def empty_optional_text(cls, value):
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("birthday")
    @classmethod
    def validate_birthday(cls, value):
        if value and value > date.today():
            raise ValueError("Ngày sinh không được ở tương lai")
        return value

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value):
        if value:
            import re

            if not re.fullmatch(r"\+?[\d\s().-]+", value) or not 9 <= len(re.sub(r"\D", "", value)) <= 15:
                raise ValueError("Số điện thoại không hợp lệ")
        return value

    @model_validator(mode="after")
    def validate_avatar_action(self):
        if self.avatar_data is not None and self.remove_avatar:
            raise ValueError("Không thể vừa thay vừa xóa ảnh đại diện")
        return self


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=8, max_length=128)

    @model_validator(mode="after")
    def validate_new_password(self):
        current = self.current_password.get_secret_value()
        new = self.new_password.get_secret_value()
        if current == new:
            raise ValueError("Mật khẩu mới phải khác mật khẩu hiện tại")
        # PostgreSQL pgcrypto uses bcrypt, which accepts at most 72 bytes.
        if len(new.encode("utf-8")) > 72:
            raise ValueError("Mật khẩu mới quá dài. Vui lòng chọn mật khẩu ngắn hơn")
        return self

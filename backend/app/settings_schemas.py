from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class GeneralSettings(BaseModel):
    organization_name: str = Field(min_length=2, max_length=200)
    timezone: str = Field(min_length=1, max_length=60)
    language: Literal["vi", "en"] = "vi"
    date_format: Literal["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] = "DD/MM/YYYY"
    time_format: Literal["24h", "12h"] = "24h"
    shift_start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class AISettings(BaseModel):
    inference_enabled: bool = True
    detection_confidence: float = Field(ge=0.1, le=0.99)
    minimum_event_interval_seconds: int = Field(ge=5, le=3600)
    save_evidence: bool = True
    store_output_video: bool = True
    auto_create_critical_incident: bool = False


class AlertSettings(BaseModel):
    in_app_enabled: bool = True
    email_enabled: bool = False
    webhook_enabled: bool = False
    critical_immediate: bool = True
    digest_interval_minutes: Literal[5, 15, 30, 60] = 15
    escalation_minutes: int = Field(ge=1, le=1440)
    quiet_hours_enabled: bool = False
    quiet_hours_start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_hours_end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @model_validator(mode="after")
    def validate_channel(self):
        if not (self.in_app_enabled or self.email_enabled or self.webhook_enabled):
            raise ValueError("Phải bật ít nhất một kênh thông báo")
        return self


class RetentionSettings(BaseModel):
    event_retention_days: int = Field(ge=30, le=3650)
    evidence_retention_days: int = Field(ge=7, le=3650)
    audit_retention_days: int = Field(ge=90, le=3650)
    auto_cleanup_enabled: bool = True


class SecuritySettings(BaseModel):
    session_timeout_minutes: int = Field(ge=15, le=1440)
    require_mfa_for_admins: bool = False
    lockout_attempts: int = Field(ge=3, le=10)
    lockout_minutes: int = Field(ge=5, le=1440)
    allow_password_login: bool = True


class SystemSettingsPayload(BaseModel):
    general: GeneralSettings
    ai: AISettings
    alerts: AlertSettings
    retention: RetentionSettings
    security: SecuritySettings


class SystemHealth(BaseModel):
    database: Literal["healthy", "degraded"]
    backend: Literal["healthy", "degraded"]
    cameras_total: int
    cameras_online: int
    models_registered: int
    events_total: int
    open_alerts: int
    active_users: int
    checked_at: datetime


class SettingsAuditItem(BaseModel):
    id: int
    action: str
    actor_name: str | None
    created_at: datetime
    changed_sections: list[str]


class SystemSettingsResponse(BaseModel):
    organization_id: UUID
    organization_code: str
    settings: SystemSettingsPayload
    health: SystemHealth
    recent_changes: list[SettingsAuditItem]
    updated_at: datetime


class SettingsActionResponse(BaseModel):
    success: bool
    message: str
    settings: SystemSettingsResponse

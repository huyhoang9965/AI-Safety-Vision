from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Content = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5000)]


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    organization_id: UUID
    recipient_id: UUID


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_id: UUID
    content: Content


class RequestCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_id: UUID
    title: Title
    description: Content
    category: Literal['support', 'incident', 'equipment', 'shift', 'other'] = 'support'
    priority: Literal['normal', 'high', 'urgent'] = 'normal'
    due_at: datetime | None = None

    @field_validator('due_at')
    @classmethod
    def future_deadline(cls, value):
        if value is not None and (value.tzinfo is None or value <= datetime.now(timezone.utc)):
            raise ValueError('Hạn xử lý phải ở tương lai và có múi giờ')
        return value


class RequestAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['in_progress', 'completed', 'rejected', 'cancelled']
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ''


class ReadMessages(BaseModel):
    model_config = ConfigDict(extra='forbid')
    through_id: int = Field(gt=0)

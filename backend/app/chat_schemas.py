from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ChatStatusResponse(BaseModel):
    available: bool
    provider: str
    model: str
    mode: Literal["openai", "local"]
    suggested_prompts: list[str]


class ConversationItem(BaseModel):
    id: UUID
    title: str
    status: str
    message_count: int
    last_message_at: datetime
    created_at: datetime
    preview: str | None


class ChatMessage(BaseModel):
    id: UUID
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    model_name: str | None
    latency_ms: int | None
    metadata: dict = Field(default_factory=dict)
    created_at: datetime
    feedback: int | None = None


class ConversationDetail(BaseModel):
    id: UUID
    title: str
    status: str
    created_at: datetime
    messages: list[ChatMessage]


class ChatSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    conversation_id: UUID | None = None


class ToolCallInfo(BaseModel):
    name: str
    label: str
    status: str
    duration_ms: int


class ChatSendResponse(BaseModel):
    conversation_id: UUID
    user_message: ChatMessage
    assistant_message: ChatMessage
    tool_calls: list[ToolCallInfo]
    mode: Literal["openai", "local"]


class FeedbackRequest(BaseModel):
    rating: Literal[-1, 1]
    comment: str | None = Field(default=None, max_length=1000)


class ChatActionResponse(BaseModel):
    success: bool
    message: str

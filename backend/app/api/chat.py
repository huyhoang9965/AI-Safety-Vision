from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.auth import require_permission
from app.chat_schemas import (
    ChatActionResponse, ChatSendRequest, ChatSendResponse, ChatStatusResponse,
    ConversationDetail, ConversationItem, FeedbackRequest,
)
from app.services import chat_service
from app.services.chat_service import ChatAccessError, ChatNotFoundError, ChatProviderError


router = APIRouter(prefix="/api/chat", tags=["admin-chatbot"])
chat_user = require_permission("chat.use")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, ChatNotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, ChatAccessError):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    if isinstance(exc, ChatProviderError):
        return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=503, detail="Không thể xử lý yêu cầu chatbot")


@router.get("/status", response_model=ChatStatusResponse)
def chatbot_status(user: Annotated[dict, Depends(chat_user)]) -> ChatStatusResponse:
    del user
    return ChatStatusResponse(**chat_service.status())


@router.get("/conversations", response_model=list[ConversationItem])
def conversations(
    user: Annotated[dict, Depends(chat_user)],
    limit: int = Query(default=30, ge=1, le=100),
) -> list[ConversationItem]:
    return [ConversationItem(**item) for item in chat_service.list_conversations(user, limit)]


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def conversation(
    conversation_id: UUID,
    user: Annotated[dict, Depends(chat_user)],
) -> ConversationDetail:
    try:
        return ConversationDetail(**chat_service.get_conversation(conversation_id, user))
    except Exception as exc:
        raise _error(exc) from exc
@router.post("/messages", response_model=ChatSendResponse)
def send(body: ChatSendRequest, user: Annotated[dict, Depends(chat_user)]) -> ChatSendResponse:
    try:
        return ChatSendResponse(**chat_service.send_message(body, user))
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/messages/{message_id}/feedback", response_model=ChatActionResponse)
def feedback(
    message_id: UUID,
    body: FeedbackRequest,
    user: Annotated[dict, Depends(chat_user)],
) -> ChatActionResponse:
    try:
        chat_service.save_feedback(message_id, body.rating, body.comment, user)
        return ChatActionResponse(success=True, message="Đã ghi nhận phản hồi")
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/conversations/{conversation_id}/archive", response_model=ChatActionResponse)
def archive(
    conversation_id: UUID,
    user: Annotated[dict, Depends(chat_user)],
) -> ChatActionResponse:
    try:
        chat_service.archive_conversation(conversation_id, user)
        return ChatActionResponse(success=True, message="Đã lưu trữ cuộc hội thoại")
    except Exception as exc:
        raise _error(exc) from exc


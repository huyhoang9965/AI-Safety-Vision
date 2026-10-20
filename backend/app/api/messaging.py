import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.auth import require_permission
from app.messaging_schemas import ConversationCreate, MessageCreate, ReadMessages, RequestAction, RequestCreate
from app.services import messaging_service as service

router = APIRouter(prefix='/api/messaging', tags=['team messaging'])
messenger = require_permission('messaging.use')
User = Annotated[dict, Depends(messenger)]
logger = logging.getLogger(__name__)


def _call(function, *args):
    try:
        return function(*args)
    except service.MessagingNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except service.MessagingForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except service.MessagingConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        logger.exception('Team messaging operation failed')
        raise HTTPException(503, 'Không thể kết nối dịch vụ tin nhắn. Vui lòng thử lại.') from exc


@router.get('/overview')
def overview(user: User, organization_id: UUID):
    return _call(service.overview, user, organization_id)


@router.get('/unread')
def unread(user: User):
    return _call(service.unread, user)


@router.post('/conversations', status_code=201)
def create_conversation(body: ConversationCreate, user: User):
    return _call(service.create_conversation, user, body)


@router.get('/conversations/{conversation_id}/messages')
def messages(conversation_id: UUID, user: User, before: int | None = Query(default=None, gt=0)):
    return _call(service.messages, user, conversation_id, before)


@router.post('/conversations/{conversation_id}/messages', status_code=201)
def send(conversation_id: UUID, body: MessageCreate, user: User):
    return _call(service.send_message, user, conversation_id, body)


@router.post('/conversations/{conversation_id}/requests', status_code=201)
def create_request(conversation_id: UUID, body: RequestCreate, user: User):
    return _call(service.create_request, user, conversation_id, body)


@router.post('/requests/{request_id}/status')
def change_request(request_id: UUID, body: RequestAction, user: User):
    return _call(service.change_request, user, request_id, body)


@router.post('/conversations/{conversation_id}/read')
def read(conversation_id: UUID, body: ReadMessages, user: User):
    return _call(service.mark_read, user, conversation_id, body)

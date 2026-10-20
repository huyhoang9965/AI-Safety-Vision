"""API authorization and transactional PostgreSQL checks (no real messages sent)."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.auth import current_user
from app.database.database import connection
from app.main import app
from app.messaging_schemas import ConversationCreate, MessageCreate, ReadMessages, RequestAction, RequestCreate
from app.services import messaging_service as service


@pytest.fixture
def account():
    return {'id': uuid4(), 'full_name': 'Nhân viên thử nghiệm', 'memberships': [
        {'organization_id': uuid4(), 'permissions': ['messaging.use'], 'is_default': True}]}


@pytest.fixture
def client(account):
    app.dependency_overrides[current_user] = lambda: account
    # Skip lifespan: these contract tests do not initialize models or the real database.
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(current_user, None)


def test_api_denies_missing_messaging_permission(client, account, monkeypatch):
    account['memberships'][0]['permissions'] = ['dashboard.view']
    called = []
    monkeypatch.setattr(service, 'unread', lambda user: called.append(user))
    assert client.get('/api/messaging/unread').status_code == 403
    assert called == []


def test_api_uses_authenticated_sender_and_rejects_spoofed_identity(client, account, monkeypatch):
    calls = []
    monkeypatch.setattr(service, 'send_message', lambda user, conversation, body: calls.append((user, body)) or {'id': 1})
    path = f'/api/messaging/conversations/{uuid4()}/messages'
    body = {'client_id': str(uuid4()), 'content': '  Kiểm tra camera  '}
    assert client.post(path, json={**body, 'sender_id': str(uuid4())}).status_code == 422
    assert client.post(path, json=body).status_code == 201
    assert calls[0][0]['id'] == account['id']
    assert calls[0][1].content == 'Kiểm tra camera'
    assert len(calls) == 1


@pytest.mark.parametrize('content', ['', '   ', 'a' * 5001])
def test_empty_and_oversize_messages_are_rejected(client, content):
    response = client.post(f'/api/messaging/conversations/{uuid4()}/messages', json={'client_id': str(uuid4()), 'content': content})
    assert response.status_code == 422


@pytest.mark.parametrize('due', ['2020-01-01T00:00:00Z', '2099-01-01T12:00:00'])
def test_request_deadline_requires_future_and_timezone(client, due):
    response = client.post(f'/api/messaging/conversations/{uuid4()}/requests', json={
        'client_id': str(uuid4()), 'title': 'Thiết bị', 'description': 'Kiểm tra', 'due_at': due})
    assert response.status_code == 422


def test_status_api_preserves_scope_errors(client, monkeypatch):
    def denied(*args):
        raise service.MessagingNotFound('Không tìm thấy yêu cầu')
    monkeypatch.setattr(service, 'change_request', denied)
    assert client.post(f'/api/messaging/requests/{uuid4()}/status', json={'status': 'completed'}).status_code == 404


def test_service_rejects_organization_without_messaging_permission(account):
    with pytest.raises(service.MessagingForbidden):
        service.overview(account, uuid4())
    account['memberships'][0]['permissions'] = []
    with pytest.raises(service.MessagingForbidden):
        service.overview(account, account['memberships'][0]['organization_id'])


def test_transitions_are_restricted_to_sender_and_recipient():
    sender, recipient, outsider = uuid4(), uuid4(), uuid4()
    request = {'sender_id': sender, 'recipient_id': recipient, 'status': 'pending'}
    service.validate_transition(request, recipient, 'in_progress', '')
    service.validate_transition(request, sender, 'cancelled', '')
    for actor, action in [(sender, 'completed'), (sender, 'in_progress'), (recipient, 'cancelled'), (outsider, 'rejected')]:
        with pytest.raises(service.MessagingForbidden):
            service.validate_transition(request, actor, action, 'Ghi chú')
    with pytest.raises(service.MessagingConflict):
        service.validate_transition(request, recipient, 'rejected', '   ')
    with pytest.raises(service.MessagingConflict):
        service.validate_transition(request, recipient, 'completed', '')
    for terminal in ['completed', 'rejected', 'cancelled']:
        with pytest.raises(service.MessagingConflict):
            service.validate_transition({**request, 'status': terminal}, recipient, 'in_progress', '')


@pytest.mark.skipif(os.getenv('TEST_MESSAGING_SQL') != '1', reason='Opt-in PostgreSQL temporary-table integration checks')
def test_postgres_two_accounts_requests_unread_pagination_and_isolation(monkeypatch):
    org, other_org = uuid4(), uuid4()
    admin, employee, outsider = [uuid4() for _ in range(3)]
    def user(uid, organization=org):
        return {'id': uid, 'full_name': 'Admin' if uid == admin else 'Employee', 'memberships': [
            {'organization_id': organization, 'permissions': ['messaging.use']}]}
    with connection() as conn:
        # All tables and their sequences live in pg_temp. Never insert into safety.*.
        conn.execute('CREATE TEMP TABLE organizations (id uuid PRIMARY KEY, is_active boolean DEFAULT true)')
        conn.execute('CREATE TEMP TABLE users (id uuid PRIMARY KEY, full_name text, avatar_url text, department text, job_title text, status text DEFAULT \'active\', deleted_at timestamptz)')
        conn.execute('CREATE TEMP TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, name text)')
        conn.execute('CREATE TEMP TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE, name text, description text)')
        conn.execute('CREATE TEMP TABLE role_permissions (role_id uuid, permission_id uuid, PRIMARY KEY (role_id, permission_id))')
        conn.execute('CREATE TEMP TABLE organization_members (organization_id uuid, user_id uuid, role_id uuid)')
        conn.execute("INSERT INTO roles (code, name) VALUES ('org_admin','Admin'),('camera_employee','Nhân viên camera')")
        migration = Path(__file__).parents[1] / 'migrations/006_team_messaging.sql'
        sql = migration.read_text(encoding='utf-8').replace('BEGIN;', '').replace('COMMIT;', '').replace('safety.', 'pg_temp.')
        conn.execute(sql)
        conn.execute(sql)  # The migration is safe to reapply during startup.
        # Reproduce an existing installation that applied the original 006 grant.
        conn.execute("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='camera_employee')")
        correction = migration.with_name('007_camera_employee_messaging.sql').read_text(encoding='utf-8')
        correction = correction.replace('BEGIN;', '').replace('COMMIT;', '').replace('safety.', 'pg_temp.')
        conn.execute(correction)
        conn.execute(correction)
        conn.execute('INSERT INTO organizations (id) VALUES (%s),(%s)', (org, other_org))
        for uid, name, organization, role in [(admin, 'Admin', org, 'org_admin'), (employee, 'Employee', org, 'camera_employee'), (outsider, 'Other', other_org, 'camera_employee')]:
            conn.execute('INSERT INTO users (id, full_name) VALUES (%s,%s)', (uid, name))
            conn.execute('INSERT INTO organization_members SELECT %s,%s,id FROM roles WHERE code=%s', (organization, uid, role))

        class Isolated:
            def execute(self, statement, params=None):
                return conn.execute(statement.replace('safety.', 'pg_temp.'), params)

        @contextmanager
        def temporary_connection():
            yield Isolated()

        monkeypatch.setattr(service, 'connection', temporary_connection)
        a, b, foreign = user(admin), user(employee), user(outsider, other_org)
        conversation = service.create_conversation(a, ConversationCreate(organization_id=org, recipient_id=employee))['id']
        assert service.create_conversation(b, ConversationCreate(organization_id=org, recipient_id=admin))['id'] == conversation
        with pytest.raises(service.MessagingForbidden):
            service.create_conversation(a, ConversationCreate(organization_id=org, recipient_id=outsider))
        with pytest.raises(service.MessagingNotFound):
            service.messages(foreign, conversation)
        body = MessageCreate(client_id=uuid4(), content='Kiểm tra camera')
        sent = service.send_message(a, conversation, body)
        assert service.send_message(a, conversation, body)['id'] == sent['id']
        assert service.unread(b)['unread'] == 1
        assert service.unread(a)['unread'] == 0
        assert len(service.overview(b, org)['contacts']) == 1
        service.mark_read(b, conversation, ReadMessages(through_id=sent['id']))
        assert service.unread(b)['unread'] == 0
        assert service.messages(a, conversation)['partner_read_id'] == sent['id']
        request_body = RequestCreate(client_id=uuid4(), title='Yêu cầu kiểm tra', description='Camera kho A', priority='urgent', due_at=datetime.now(timezone.utc) + timedelta(days=1))
        result = service.create_request(b, conversation, request_body)
        assert service.create_request(b, conversation, request_body)['request_id'] == result['request_id']
        request_id = result['request_id']
        assert service.overview(a, org)['summary']['pending'] == 1
        with pytest.raises(service.MessagingForbidden):
            service.change_request(b, request_id, RequestAction(status='in_progress'))
        service.change_request(a, request_id, RequestAction(status='in_progress'))
        service.change_request(a, request_id, RequestAction(status='completed', note='Đã kiểm tra'))
        with pytest.raises(service.MessagingConflict):
            service.change_request(a, request_id, RequestAction(status='rejected', note='Quá muộn'))
        assert service.overview(b, org)['requests'][0]['status'] == 'completed'
        assert service.overview(a, org)['summary']['completed'] == 1
        for index in range(52):
            service.send_message(a, conversation, MessageCreate(client_id=uuid4(), content=f'Tin {index}'))
        newest = service.messages(b, conversation)
        assert len(newest['items']) == 50 and newest['has_more']
        older = service.messages(b, conversation, before=newest['items'][0]['id'])
        assert older['items'][-1]['id'] < newest['items'][0]['id']
        assert not older['has_more']
        # Removing org membership immediately removes access to historical messages.
        conn.execute('DELETE FROM organization_members WHERE user_id=%s', (employee,))
        with pytest.raises(service.MessagingForbidden):
            service.messages(a, conversation)
        assert service.unread(a)['unread'] == 0
        conn.rollback()

"""Private, organization-scoped conversations. All writes lock the conversation.

The lock keeps message order, read cursors, request transitions and retries consistent.
Client-generated IDs make a retry after a lost response safe.
"""
from uuid import UUID, uuid4

from app.database.database import connection


class MessagingNotFound(ValueError):
    pass


class MessagingForbidden(ValueError):
    pass


class MessagingConflict(ValueError):
    pass


def organization_ids(user):
    return [str(m['organization_id']) for m in user.get('memberships', [])
            if 'messaging.use' in m.get('permissions', [])]


def _scope(user, organization_id):
    if str(organization_id) not in organization_ids(user):
        raise MessagingForbidden('Bạn không có quyền trao đổi trong tổ chức này')


def _eligible_member(conn, organization_id, user_id):
    return conn.execute(
        """SELECT u.id FROM safety.organization_members om
           JOIN safety.users u ON u.id = om.user_id AND u.status = 'active' AND u.deleted_at IS NULL
           JOIN safety.organizations o ON o.id = om.organization_id AND o.is_active
           WHERE om.organization_id = %s AND om.user_id = %s
             AND EXISTS (SELECT 1 FROM safety.role_permissions rp
                         JOIN safety.permissions p ON p.id = rp.permission_id
                         WHERE rp.role_id = om.role_id AND p.code = 'messaging.use')""",
        (organization_id, user_id),
    ).fetchone()


def _conversation(conn, conversation_id, user, lock=False):
    row = conn.execute(
        """SELECT * FROM safety.team_conversations WHERE id = %s
           AND organization_id = ANY(%s::uuid[])
           AND %s::uuid IN (participant_a, participant_b)""" + (' FOR UPDATE' if lock else ''),
        (conversation_id, organization_ids(user), user['id']),
    ).fetchone()
    if not row:
        raise MessagingNotFound('Không tìm thấy cuộc hội thoại trong phạm vi của bạn')
    for participant in (row['participant_a'], row['participant_b']):
        if not _eligible_member(conn, row['organization_id'], participant):
            raise MessagingForbidden('Một thành viên không còn quyền trao đổi trong tổ chức này')
    return row


def _partner(row, user):
    return row['participant_b'] if str(row['participant_a']) == str(user['id']) else row['participant_a']


def _read_column(row, user):
    return 'read_a' if str(row['participant_a']) == str(user['id']) else 'read_b'


def _request_select():
    return """SELECT r.*, sender.full_name AS sender_name, recipient.full_name AS recipient_name
              FROM safety.team_requests r
              JOIN safety.users sender ON sender.id = r.sender_id
              JOIN safety.users recipient ON recipient.id = r.recipient_id """


def overview(user, organization_id):
    _scope(user, organization_id)
    with connection() as conn:
        contacts = conn.execute(
            """SELECT u.id, u.full_name, u.avatar_url, u.department, u.job_title,
                      r.code AS role_code, r.name AS role_name
               FROM safety.organization_members om
               JOIN safety.users u ON u.id = om.user_id AND u.status = 'active' AND u.deleted_at IS NULL
               JOIN safety.roles r ON r.id = om.role_id
               WHERE om.organization_id = %s AND u.id <> %s
                 AND EXISTS (SELECT 1 FROM safety.role_permissions rp
                             JOIN safety.permissions p ON p.id = rp.permission_id
                             WHERE rp.role_id = om.role_id AND p.code = 'messaging.use')
               ORDER BY CASE WHEN r.code IN ('super_admin','org_admin') THEN 0 ELSE 1 END, u.full_name""",
            (organization_id, user['id']),
        ).fetchall()
        conversations = conn.execute(
            """SELECT c.id, c.organization_id, c.updated_at,
                      CASE WHEN c.participant_a = %s THEN c.participant_b ELSE c.participant_a END AS partner_id,
                      last.content AS last_message, last.kind AS last_kind, last.created_at AS last_message_at,
                      (SELECT count(*)::int FROM safety.team_messages m WHERE m.conversation_id = c.id
                        AND m.sender_id <> %s AND m.id > CASE WHEN c.participant_a = %s THEN c.read_a ELSE c.read_b END) AS unread_count
               FROM safety.team_conversations c
               LEFT JOIN LATERAL (SELECT content, kind, created_at FROM safety.team_messages
                                  WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) last ON true
               WHERE c.organization_id = %s AND %s::uuid IN (c.participant_a, c.participant_b)
               ORDER BY c.updated_at DESC, c.id""",
            (user['id'], user['id'], user['id'], organization_id, user['id']),
        ).fetchall()
        available = {str(contact['id']) for contact in contacts}
        conversations = [dict(c) for c in conversations if str(c['partner_id']) in available]
        ids = [c['id'] for c in conversations]
        requests = conn.execute(
            _request_select() + ' WHERE r.conversation_id = ANY(%s::uuid[]) ORDER BY r.created_at DESC, r.request_no DESC LIMIT 200',
            (ids,),
        ).fetchall()
        summary = conn.execute(
            """SELECT count(*)::int AS requests_total,
                      count(*) FILTER (WHERE recipient_id = %s AND status = 'pending')::int AS pending,
                      count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
                      count(*) FILTER (WHERE status = 'completed')::int AS completed,
                      count(*) FILTER (WHERE due_at < now() AND status IN ('pending','in_progress'))::int AS overdue
               FROM safety.team_requests WHERE conversation_id = ANY(%s::uuid[])""",
            (user['id'], ids),
        ).fetchone()
    return {'contacts': contacts, 'conversations': conversations, 'requests': requests,
            'summary': {**summary, 'unread': sum(c['unread_count'] for c in conversations)}}


def unread(user):
    with connection() as conn:
        row = conn.execute(
            """SELECT count(*)::int AS unread FROM safety.team_messages m
               JOIN safety.team_conversations c ON c.id = m.conversation_id
               JOIN safety.organization_members om ON om.organization_id = c.organization_id
                 AND om.user_id = CASE WHEN c.participant_a = %s THEN c.participant_b ELSE c.participant_a END
               JOIN safety.users partner ON partner.id = om.user_id AND partner.status = 'active' AND partner.deleted_at IS NULL
               WHERE c.organization_id = ANY(%s::uuid[]) AND %s::uuid IN (c.participant_a,c.participant_b)
                 AND m.sender_id <> %s AND m.id > CASE WHEN c.participant_a = %s THEN c.read_a ELSE c.read_b END
                 AND EXISTS (SELECT 1 FROM safety.role_permissions rp
                             JOIN safety.permissions p ON p.id = rp.permission_id
                             WHERE rp.role_id = om.role_id AND p.code = 'messaging.use')""",
            (user['id'], organization_ids(user), user['id'], user['id'], user['id']),
        ).fetchone()
    return row


def create_conversation(user, body):
    _scope(user, body.organization_id)
    if str(body.recipient_id) == str(user['id']):
        raise MessagingConflict('Vui lòng chọn một người nhận khác')
    with connection() as conn:
        if not _eligible_member(conn, body.organization_id, body.recipient_id):
            raise MessagingForbidden('Người nhận không thuộc tổ chức hoặc không có quyền trao đổi')
        first, second = sorted([UUID(str(user['id'])), body.recipient_id])
        row = conn.execute(
            """INSERT INTO safety.team_conversations (organization_id, participant_a, participant_b)
               VALUES (%s, %s, %s) ON CONFLICT (organization_id, participant_a, participant_b)
               DO UPDATE SET organization_id = EXCLUDED.organization_id RETURNING id""",
            (body.organization_id, first, second),
        ).fetchone()
    return row


def messages(user, conversation_id, before=None):
    with connection() as conn:
        conversation = _conversation(conn, conversation_id, user)
        rows = conn.execute(
            """SELECT m.*, to_jsonb(r) AS request FROM safety.team_messages m
               LEFT JOIN safety.team_requests r ON r.id = m.request_id
               WHERE m.conversation_id = %s AND (%s::bigint IS NULL OR m.id < %s)
               ORDER BY m.id DESC LIMIT 51""", (conversation_id, before, before),
        ).fetchall()
        partner_column = 'read_b' if _read_column(conversation, user) == 'read_a' else 'read_a'
    return {'items': list(reversed(rows[:50])), 'has_more': len(rows) > 50,
            'partner_read_id': conversation[partner_column]}


def _duplicate(conn, conversation_id, user, client_id):
    return conn.execute(
        'SELECT id, request_id FROM safety.team_messages WHERE conversation_id = %s AND sender_id = %s AND client_id = %s',
        (conversation_id, user['id'], client_id),
    ).fetchone()


def _insert_message(conn, conversation_id, user, client_id, kind, content, request_id=None):
    row = conn.execute(
        """INSERT INTO safety.team_messages (conversation_id, sender_id, client_id, kind, content, request_id)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, request_id""",
        (conversation_id, user['id'], client_id, kind, content, request_id),
    ).fetchone()
    conn.execute('UPDATE safety.team_conversations SET updated_at = now() WHERE id = %s', (conversation_id,))
    return row


def send_message(user, conversation_id, body):
    with connection() as conn:
        _conversation(conn, conversation_id, user, lock=True)
        prior = _duplicate(conn, conversation_id, user, body.client_id)
        return prior or _insert_message(conn, conversation_id, user, body.client_id, 'text', body.content)


def create_request(user, conversation_id, body):
    with connection() as conn:
        conversation = _conversation(conn, conversation_id, user, lock=True)
        prior = _duplicate(conn, conversation_id, user, body.client_id)
        if prior:
            return prior
        row = conn.execute(
            """INSERT INTO safety.team_requests
               (conversation_id, sender_id, recipient_id, title, description, category, priority, due_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (conversation_id, user['id'], _partner(conversation, user), body.title,
             body.description, body.category, body.priority, body.due_at),
        ).fetchone()
        return _insert_message(conn, conversation_id, user, body.client_id, 'request', body.title, row['id'])


def validate_transition(request, user_id, new_status, note):
    sender = str(request['sender_id']) == str(user_id)
    recipient = str(request['recipient_id']) == str(user_id)
    if (new_status == 'cancelled' and not sender) or (new_status != 'cancelled' and not recipient):
        raise MessagingForbidden('Chỉ người nhận được xử lý yêu cầu; người gửi có thể hủy yêu cầu')
    allowed = {'pending': {'in_progress', 'rejected', 'cancelled'}, 'in_progress': {'completed', 'cancelled'}}
    if new_status not in allowed.get(request['status'], set()):
        raise MessagingConflict('Yêu cầu đã thay đổi trạng thái. Vui lòng tải lại để xem cập nhật')
    if new_status == 'rejected' and not note.strip():
        raise MessagingConflict('Vui lòng nhập lý do từ chối')


def change_request(user, request_id, body):
    with connection() as conn:
        lookup = conn.execute('SELECT conversation_id FROM safety.team_requests WHERE id = %s', (request_id,)).fetchone()
        if not lookup:
            raise MessagingNotFound('Không tìm thấy yêu cầu')
        _conversation(conn, lookup['conversation_id'], user, lock=True)
        row = conn.execute('SELECT * FROM safety.team_requests WHERE id = %s FOR UPDATE', (request_id,)).fetchone()
        validate_transition(row, user['id'], body.status, body.note)
        updated = conn.execute(
            'UPDATE safety.team_requests SET status = %s, resolution_note = %s, updated_at = now() WHERE id = %s RETURNING *',
            (body.status, body.note or None, request_id),
        ).fetchone()
        labels = {'in_progress': 'đã tiếp nhận', 'completed': 'đã hoàn thành', 'rejected': 'đã từ chối', 'cancelled': 'đã hủy'}
        content = f"{user['full_name']} {labels[body.status]} yêu cầu YC-{row['request_no']:04d}"
        if body.note:
            content += ': ' + body.note
        _insert_message(conn, row['conversation_id'], user, uuid4(), 'activity', content, request_id)
    return updated


def mark_read(user, conversation_id, body):
    with connection() as conn:
        row = _conversation(conn, conversation_id, user, lock=True)
        message = conn.execute('SELECT id FROM safety.team_messages WHERE conversation_id = %s AND id = %s',
                               (conversation_id, body.through_id)).fetchone()
        if not message:
            raise MessagingNotFound('Không tìm thấy tin nhắn')
        column = _read_column(row, user)
        conn.execute(f'UPDATE safety.team_conversations SET {column} = GREATEST({column}, %s) WHERE id = %s',
                     (body.through_id, conversation_id))
    return {'success': True}

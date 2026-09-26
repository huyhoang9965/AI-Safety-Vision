from __future__ import annotations

import json
import time
import unicodedata
from datetime import date, datetime
from typing import Any
from uuid import UUID

from app.chat_schemas import ChatSendRequest
from app.database.database import connection
from app.services import alert_service, camera_service, incident_service, user_service


class ChatNotFoundError(ValueError):
    pass


class ChatAccessError(ValueError):
    pass


class ChatProviderError(RuntimeError):
    pass


SUGGESTIONS = [
    "Tóm tắt tình hình an toàn hôm nay",
    "Camera nào đang ngoại tuyến?",
    "Liệt kê cảnh báo nghiêm trọng chưa xử lý",
    "Sự cố nào đang quá hạn?",
    "Tình trạng người dùng và phiên đăng nhập",
]

TOOL_LABELS = {
    "get_dashboard_summary": "Tổng hợp dashboard",
    "list_cameras": "Tra cứu camera",
    "list_alerts": "Tra cứu cảnh báo",
    "list_incidents": "Tra cứu sự cố",
    "get_incident_detail": "Đọc chi tiết sự cố",
    "list_users": "Tra cứu người dùng",
}


def _primary_membership(user: dict[str, Any]) -> dict[str, Any]:
    memberships = user.get("memberships", [])
    if not memberships:
        raise ChatAccessError("Tài khoản chưa thuộc tổ chức nào")
    return next((item for item in memberships if item.get("is_default")), memberships[0])


def _permission_set(user: dict[str, Any]) -> set[str]:
    return {
        permission
        for membership in user.get("memberships", [])
        for permission in membership.get("permissions", [])
    }


def status() -> dict[str, Any]:
    return {
        "available": True,
        "provider": "Trợ lý dữ liệu nội bộ",
        "model": "local-readonly-v1",
        "mode": "local",
        "suggested_prompts": SUGGESTIONS,
    }


def list_conversations(user: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    membership = _primary_membership(user)
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.status, c.last_message_at, c.created_at,
                   count(m.id)::int AS message_count,
                   (SELECT left(cm.content, 160) FROM safety.chat_messages cm
                    WHERE cm.conversation_id=c.id AND cm.role='assistant'
                    ORDER BY cm.created_at DESC LIMIT 1) AS preview
            FROM safety.chat_conversations c
            LEFT JOIN safety.chat_messages m ON m.conversation_id=c.id
            WHERE c.organization_id=%s AND c.user_id=%s AND c.status='open'
            GROUP BY c.id ORDER BY c.last_message_at DESC LIMIT %s
            """, (membership["organization_id"], user["id"], limit),
        ).fetchall()
    return [dict(row) for row in rows]


def _conversation(conn: Any, conversation_id: UUID, user: dict[str, Any]) -> dict[str, Any]:
    membership = _primary_membership(user)
    row = conn.execute(
        """SELECT id,title,status,created_at FROM safety.chat_conversations
           WHERE id=%s AND organization_id=%s AND user_id=%s""",
        (conversation_id, membership["organization_id"], user["id"]),
    ).fetchone()
    if not row:
        raise ChatNotFoundError("Không tìm thấy cuộc hội thoại")
    return dict(row)


def get_conversation(conversation_id: UUID, user: dict[str, Any]) -> dict[str, Any]:
    with connection() as conn:
        conversation_row = _conversation(conn, conversation_id, user)
        messages = conn.execute(
            """
            SELECT m.id,m.role,m.content,m.model_name,m.latency_ms,m.metadata,m.created_at,
                   f.rating AS feedback
            FROM safety.chat_messages m
            LEFT JOIN safety.chat_feedback f ON f.message_id=m.id AND f.user_id=%s
            WHERE m.conversation_id=%s AND m.role IN ('user','assistant')
            ORDER BY m.created_at
            """, (user["id"], conversation_id),
        ).fetchall()
    conversation_row["messages"] = [dict(row) for row in messages]
    return conversation_row


def _create_conversation(conn: Any, message: str, user: dict[str, Any]) -> UUID:
    membership = _primary_membership(user)
    title = " ".join(message.strip().split())[:80]
    row = conn.execute(
        """INSERT INTO safety.chat_conversations
           (organization_id,user_id,title) VALUES (%s,%s,%s) RETURNING id""",
        (membership["organization_id"], user["id"], title or "Cuộc trò chuyện mới"),
    ).fetchone()
    return row["id"]


def _save_message(conn: Any, conversation_id: UUID, role: str, content: str,
                  model: str | None = None, input_tokens: int | None = None,
                  output_tokens: int | None = None, latency_ms: int | None = None,
                  metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    row = conn.execute(
        """INSERT INTO safety.chat_messages
           (conversation_id,role,content,model_name,input_tokens,output_tokens,latency_ms,metadata)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
           RETURNING id,role,content,model_name,latency_ms,metadata,created_at""",
        (conversation_id, role, content, model, input_tokens, output_tokens,
         latency_ms, json.dumps(metadata or {}, ensure_ascii=False)),
    ).fetchone()
    conn.execute(
        "UPDATE safety.chat_conversations SET updated_at=now(),last_message_at=now() WHERE id=%s",
        (conversation_id,),
    )
    payload = dict(row)
    payload["feedback"] = None
    return payload


def _history(conversation_id: UUID, limit: int = 16) -> list[dict[str, str]]:
    with connection() as conn:
        rows = conn.execute(
            """SELECT role,content FROM (
                 SELECT role,content,created_at FROM safety.chat_messages
                 WHERE conversation_id=%s AND role IN ('user','assistant')
                 ORDER BY created_at DESC LIMIT %s
               ) recent ORDER BY created_at""", (conversation_id, limit),
        ).fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in rows]


def _json_safe(value: Any) -> Any:
    if isinstance(value, (UUID, datetime, date)):
        return value.isoformat() if hasattr(value, "isoformat") else str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _allowed_tool_names(user: dict[str, Any]) -> set[str]:
    permissions = _permission_set(user)
    allowed = {"get_dashboard_summary"}
    if "camera.view" in permissions:
        allowed.add("list_cameras")
    if "event.view" in permissions:
        allowed.add("list_alerts")
    if "incident.view" in permissions:
        allowed.update({"list_incidents", "get_incident_detail"})
    if "user.view" in permissions:
        allowed.add("list_users")
    return allowed


def _tool_definitions(user: dict[str, Any]) -> list[dict[str, Any]]:
    definitions: dict[str, dict[str, Any]] = {
        "get_dashboard_summary": {
            "description": "Lấy KPI tổng quan hiện tại về camera, cảnh báo, sự cố và người dùng mà tài khoản được phép xem.",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
        "list_cameras": {
            "description": "Liệt kê camera theo trạng thái hoặc từ khóa. Dùng khi hỏi tình trạng camera, kết nối, vị trí hoặc thiết bị.",
            "parameters": {"type": "object", "properties": {
                "status": {"enum": [None, "online", "offline", "warning", "maintenance", "disabled"]},
                "search": {"type": ["string", "null"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            }, "required": ["status", "search", "limit"], "additionalProperties": False},
        },
        "list_alerts": {
            "description": "Liệt kê cảnh báo/vi phạm AI theo trạng thái, mức nghiêm trọng và khoảng thời gian.",
            "parameters": {"type": "object", "properties": {
                "status": {"enum": [None, "new", "acknowledged", "resolved", "dismissed"]},
                "severity": {"enum": [None, "low", "medium", "high", "critical"]},
                "period": {"enum": ["today", "7d", "30d", "90d", "all"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            }, "required": ["status", "severity", "period", "limit"], "additionalProperties": False},
        },
        "list_incidents": {
            "description": "Liệt kê sự cố theo trạng thái, mức nghiêm trọng và thời gian; kết quả có SLA/quá hạn.",
            "parameters": {"type": "object", "properties": {
                "status": {"enum": [None, "open", "investigating", "resolved", "closed"]},
                "severity": {"enum": [None, "low", "medium", "high", "critical"]},
                "period": {"enum": ["today", "7d", "30d", "90d", "all"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            }, "required": ["status", "severity", "period", "limit"], "additionalProperties": False},
        },
        "get_incident_detail": {
            "description": "Đọc hồ sơ đầy đủ một sự cố khi đã có UUID sự cố từ list_incidents.",
            "parameters": {"type": "object", "properties": {
                "incident_id": {"type": "string", "format": "uuid"},
            }, "required": ["incident_id"], "additionalProperties": False},
        },
        "list_users": {
            "description": "Liệt kê tài khoản, vai trò, trạng thái và phiên đăng nhập trong tổ chức.",
            "parameters": {"type": "object", "properties": {
                "status": {"enum": [None, "pending", "active", "locked", "disabled"]},
                "role_code": {"type": ["string", "null"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            }, "required": ["status", "role_code", "limit"], "additionalProperties": False},
        },
    }
    return [
        {"type": "function", "name": name, "description": definitions[name]["description"],
         "parameters": definitions[name]["parameters"], "strict": True}
        for name in _allowed_tool_names(user) if name in definitions
    ]


def _execute_tool(name: str, arguments: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    if name not in _allowed_tool_names(user):
        raise ChatAccessError("Bạn không có quyền sử dụng công cụ " + name)
    limit = max(1, min(int(arguments.get("limit") or 10), 20))
    if name == "get_dashboard_summary":
        permissions = _permission_set(user)
        result: dict[str, Any] = {"generated_at": datetime.now().astimezone().isoformat()}
        if "camera.view" in permissions:
            result["cameras"] = camera_service.list_infrastructure(user)["summary"]
        if "event.view" in permissions:
            result["alerts"] = alert_service.list_alerts(
                user, None, None, None, None, None, None, "today", 1, 0
            )["summary"]
        if "incident.view" in permissions:
            result["incidents"] = incident_service.list_incidents(
                user, None, None, None, None, None, "30d", 1, 0
            )["summary"]
        if "user.view" in permissions:
            result["users"] = user_service.list_users(user)["summary"]
        result["source_url"] = "/dashboard"
        return _json_safe(result)
    if name == "list_cameras":
        payload = camera_service.list_infrastructure(user)
        status_filter = arguments.get("status")
        search = str(arguments.get("search") or "").casefold()
        rows = [item for item in payload["cameras"] if
                (not status_filter or item["status"] == status_filter) and
                (not search or search in " ".join(str(item.get(key) or "") for key in
                 ("code", "name", "site_name", "zone_name", "ip_address")).casefold())]
        items = [{key: item.get(key) for key in (
            "id", "code", "name", "status", "site_name", "zone_name", "ip_address",
            "last_seen_at", "latest_latency_ms", "latest_packet_loss_pct", "deployment_count",
        )} for item in rows[:limit]]
        return _json_safe({"total": len(rows), "items": items, "summary": payload["summary"],
                           "source_url": "/dashboard/cameras"})
    if name == "list_alerts":
        payload = alert_service.list_alerts(
            user, arguments.get("status"), arguments.get("severity"), None, None,
            None, None, arguments.get("period") or "30d", limit, 0,
        )
        items = [{key: item.get(key) for key in (
            "id", "title", "event_name", "severity", "status", "confidence",
            "detected_at", "site_name", "zone_name", "camera_name",
        )} for item in payload["items"]]
        return _json_safe({"total": payload["total"], "summary": payload["summary"],
                           "items": items, "source_url": "/dashboard/alerts"})
    if name == "list_incidents":
        payload = incident_service.list_incidents(
            user, arguments.get("status"), arguments.get("severity"), None, None,
            None, arguments.get("period") or "30d", limit, 0,
        )
        items = [{key: item.get(key) for key in (
            "id", "incident_no", "title", "severity", "status", "site_name",
            "assigned_to", "opened_at", "due_at", "overdue", "event_count",
        )} for item in payload["items"]]
        return _json_safe({"total": payload["total"], "summary": payload["summary"],
                           "items": items, "source_url": "/dashboard/incidents"})
    if name == "get_incident_detail":
        result = incident_service.detail(UUID(str(arguments["incident_id"])), user)
        return _json_safe({"incident": result, "source_url": "/dashboard/incidents"})
    if name == "list_users":
        payload = user_service.list_users(user)
        status_filter = arguments.get("status")
        role_filter = arguments.get("role_code")
        rows = [item for item in payload["users"] if
                (not status_filter or item["status"] == status_filter) and
                (not role_filter or item["role_code"] == role_filter)]
        items = [{key: item.get(key) for key in (
            "id", "full_name", "email", "status", "role_name", "role_code",
            "department", "last_login_at", "active_sessions", "site_count",
        )} for item in rows[:limit]]
        return _json_safe({"total": len(rows), "summary": payload["summary"],
                           "items": items, "source_url": "/dashboard/users"})
    raise ValueError("Công cụ chatbot không tồn tại")


def _plain(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.casefold())
    return "".join(char for char in normalized if unicodedata.category(char) != "Mn").replace("đ", "d")


def _source_list(results: list[tuple[str, dict[str, Any]]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    sources: list[dict[str, str]] = []
    for name, result in results:
        url = result.get("source_url")
        if url and url not in seen:
            seen.add(url)
            sources.append({"label": TOOL_LABELS.get(name, name), "url": url})
    return sources


def _local_answer(message: str, user: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[dict[str, str]]]:
    query = _plain(message)
    allowed = _allowed_tool_names(user)
    name = "get_dashboard_summary"
    arguments: dict[str, Any] = {}
    if any(word in query for word in ("camera", "ngoai tuyen", "mat ket noi")) and "list_cameras" in allowed:
        name = "list_cameras"
        camera_status = None
        if any(word in query for word in ("ngoai tuyen", "mat ket noi", "offline")):
            camera_status = "offline"
        elif any(word in query for word in ("bao tri", "maintenance")):
            camera_status = "maintenance"
        elif any(word in query for word in ("canh bao", "warning")):
            camera_status = "warning"
        elif any(word in query for word in ("truc tuyen", "online")):
            camera_status = "online"
        arguments = {"status": camera_status, "search": None, "limit": 10}
    elif any(word in query for word in ("canh bao", "vi pham", "mu bao ho", "ao bao ho")) and "list_alerts" in allowed:
        name = "list_alerts"
        severity = "critical" if any(word in query for word in ("nghiem trong", "critical")) else None
        status_filter = "new" if any(word in query for word in ("chua xu ly", "moi")) else None
        period = "today" if any(word in query for word in ("hom nay", "trong ngay")) else "7d" if "7 ngay" in query else "30d"
        arguments = {"status": status_filter, "severity": severity, "period": period, "limit": 10}
    elif any(word in query for word in ("su co", "qua han", "sla")) and "list_incidents" in allowed:
        name = "list_incidents"
        status_filter = "open" if any(word in query for word in ("dang mo", "chua xu ly")) else None
        severity = "critical" if any(word in query for word in ("nghiem trong", "critical")) else None
        arguments = {"status": status_filter, "severity": severity, "period": "30d", "limit": 10}
    elif any(word in query for word in ("nguoi dung", "tai khoan", "phan quyen", "phien dang nhap")) and "list_users" in allowed:
        name = "list_users"
        status_filter = "locked" if "bi khoa" in query or "da khoa" in query else "active" if "hoat dong" in query else None
        arguments = {"status": status_filter, "role_code": None, "limit": 10}
    started = time.perf_counter()
    result = _execute_tool(name, arguments, user)
    duration = round((time.perf_counter() - started) * 1000)
    record = {"name": name, "arguments": arguments, "result": result,
              "status": "completed", "duration_ms": duration}
    return _format_local_result(name, result, query), [record], _source_list([(name, result)])


def _format_local_result(name: str, result: dict[str, Any], query: str) -> str:
    if name == "get_dashboard_summary":
        cameras = result.get("cameras", {})
        alerts = result.get("alerts", {})
        incidents = result.get("incidents", {})
        users = result.get("users", {})
        return (
            "Tóm tắt vận hành hiện tại:\n\n"
            f"• Camera: {cameras.get('cameras', 0)} thiết bị, {cameras.get('online', 0)} trực tuyến, "
            f"{cameras.get('offline', 0)} ngoại tuyến và {cameras.get('warning', 0)} cảnh báo.\n"
            f"• Cảnh báo hôm nay: {alerts.get('total', 0)}, trong đó {alerts.get('critical', 0)} nghiêm trọng.\n"
            f"• Sự cố 30 ngày: {incidents.get('total', 0)}, {incidents.get('overdue', 0)} quá hạn.\n"
            f"• Người dùng: {users.get('total', 0)} tài khoản, {users.get('active', 0)} đang hoạt động.\n\n"
            "Dữ liệu được đọc trực tiếp từ hệ thống tại thời điểm yêu cầu."
        )
    if name == "list_cameras":
        items = result.get("items", [])
        lines = [f"Tìm thấy {result.get('total', 0)} camera phù hợp."]
        lines.extend(
            f"• {item['code']} — {item['name']}: {item['status']} tại "
            f"{item.get('zone_name') or item.get('site_name') or 'chưa gán vị trí'}"
            + (f", độ trễ {item['latest_latency_ms']} ms." if item.get("latest_latency_ms") is not None else ".")
            for item in items
        )
        return "\n".join(lines) if items else lines[0] + " Hiện không có thiết bị trong nhóm này."
    if name == "list_alerts":
        items = result.get("items", [])
        lines = [f"Có {result.get('total', 0)} cảnh báo phù hợp."]
        lines.extend(
            f"• {item['title']} — mức {item['severity']}, trạng thái {item['status']}, "
            f"camera {item.get('camera_name') or 'không rõ'}." for item in items
        )
        return "\n".join(lines) if items else lines[0] + " Không có cảnh báo cần liệt kê."
    if name == "list_incidents":
        items = result.get("items", [])
        if "qua han" in query:
            items = [item for item in items if item.get("overdue")]
        lines = [f"Có {len(items) if 'qua han' in query else result.get('total', 0)} sự cố phù hợp."]
        lines.extend(
            f"• #{item['incident_no']} {item['title']} — mức {item['severity']}, {item['status']}"
            f"{' (quá hạn)' if item.get('overdue') else ''}." for item in items
        )
        return "\n".join(lines) if items else lines[0] + " Không có sự cố cần liệt kê."
    if name == "list_users":
        items = result.get("items", [])
        lines = [f"Tổ chức hiện có {result.get('total', 0)} tài khoản phù hợp."]
        lines.extend(
            f"• {item['full_name']} — {item['role_name']}, trạng thái {item['status']}, "
            f"{item['active_sessions']} phiên hoạt động." for item in items
        )
        return "\n".join(lines)
    return "Đã đọc dữ liệu hệ thống theo quyền của bạn."


def send_message(body: ChatSendRequest, user: dict[str, Any]) -> dict[str, Any]:
    content = " ".join(body.message.strip().split())
    if not content:
        raise ValueError("Tin nhắn không được để trống")
    with connection() as conn:
        if body.conversation_id:
            conversation_row = _conversation(conn, body.conversation_id, user)
            if conversation_row["status"] != "open":
                raise ValueError("Cuộc hội thoại đã được lưu trữ")
            conversation_id = body.conversation_id
        else:
            conversation_id = _create_conversation(conn, content, user)
        user_message = _save_message(conn, conversation_id, "user", content)

    started = time.perf_counter()
    answer, tool_records, sources = _local_answer(content, user)
    latency = round((time.perf_counter() - started) * 1000)
    metadata = {"mode": "local", "sources": sources,
                "tools": [record["name"] for record in tool_records], "read_only": True}
    with connection() as conn:
        assistant_message = _save_message(
            conn, conversation_id, "assistant", answer, "local-readonly-v1",
            0, 0, latency, metadata,
        )
        for record in tool_records:
            conn.execute(
                """INSERT INTO safety.chat_tool_calls
                   (conversation_id,request_message_id,tool_name,arguments,result_summary,status,duration_ms)
                   VALUES (%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s)""",
                (conversation_id, user_message["id"], record["name"],
                 json.dumps(record["arguments"], ensure_ascii=False),
                 json.dumps(record["result"], ensure_ascii=False, default=str),
                 record["status"], record["duration_ms"]),
            )
    return {
        "conversation_id": conversation_id,
        "user_message": user_message,
        "assistant_message": assistant_message,
        "tool_calls": [{"name": record["name"], "label": TOOL_LABELS.get(record["name"], record["name"]),
                        "status": record["status"], "duration_ms": record["duration_ms"]}
                       for record in tool_records],
        "mode": "local",
    }


def save_feedback(message_id: UUID, rating: int, comment: str | None,
                  user: dict[str, Any]) -> None:
    membership = _primary_membership(user)
    with connection() as conn:
        message = conn.execute(
            """SELECT m.id FROM safety.chat_messages m
               JOIN safety.chat_conversations c ON c.id=m.conversation_id
               WHERE m.id=%s AND m.role='assistant' AND c.user_id=%s AND c.organization_id=%s""",
            (message_id, user["id"], membership["organization_id"]),
        ).fetchone()
        if not message:
            raise ChatNotFoundError("Không tìm thấy câu trả lời")
        conn.execute(
            """INSERT INTO safety.chat_feedback (message_id,user_id,rating,comment)
               VALUES (%s,%s,%s,%s)
               ON CONFLICT (message_id,user_id) DO UPDATE SET
                 rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=now()""",
            (message_id, user["id"], rating, comment),
        )


def archive_conversation(conversation_id: UUID, user: dict[str, Any]) -> None:
    with connection() as conn:
        _conversation(conn, conversation_id, user)
        conn.execute(
            "UPDATE safety.chat_conversations SET status='archived',updated_at=now() WHERE id=%s",
            (conversation_id,),
        )

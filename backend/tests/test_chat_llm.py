from contextlib import nullcontext
from dataclasses import replace
import json
from unittest.mock import Mock
from uuid import uuid4

import httpx
import pytest

from app.chat_schemas import ChatSendRequest
from app.config import get_settings
from app.services import chat_llm, chat_service


@pytest.fixture
def settings():
    return replace(get_settings(), openrouter_api_key="fake-test-key", chat_llm_share_internal_data=False)


@pytest.fixture
def user():
    return {"id": uuid4(), "full_name": "PRIVATE ACCOUNT NAME", "memberships": [{
        "organization_id": uuid4(), "organization_name": "PRIVATE ORG NAME", "is_default": True,
        "permissions": ["camera.view", "event.view", "incident.view", "user.view"],
    }]}


def completion(content=None, calls=None, **extra):
    message = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    message.update(extra)
    return {"choices": [{"message": message}], "model": "test-model",
            "usage": {"prompt_tokens": 9, "completion_tokens": 4}}


def call(name="list_cameras", arguments=None, identifier="call-1"):
    return {"id": identifier, "type": "function", "function": {"name": name,
            "arguments": json.dumps(arguments if arguments is not None else {"status": "offline", "search": None, "limit": 5})}}


def mock_provider(monkeypatch, responses):
    payloads = []
    original_client = httpx.Client
    queue = iter(responses)

    def handler(request):
        assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer fake-test-key"
        payloads.append(json.loads(request.content))
        response = next(queue)
        if isinstance(response, Exception):
            raise response
        return response if isinstance(response, httpx.Response) else httpx.Response(200, json=response)

    monkeypatch.setattr(chat_llm.httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    return payloads


def answer(settings, user, execute=None, history=None):
    return chat_llm.generate_answer(history or [{"role": "user", "content": "chào bạn"}], user,
        chat_service._tool_definitions(user), execute or Mock(), settings,
        lambda name, result, query: chat_service._format_local_result(name, result, chat_service._plain(query)))


def test_greeting_uses_llm_without_database_or_account_identity(monkeypatch, settings, user):
    payloads = mock_provider(monkeypatch, [completion("Chào bạn! Mình có thể giúp gì hôm nay?")])
    execute = Mock()
    result = answer(settings, user, execute)
    assert result.content.startswith("Chào bạn")
    execute.assert_not_called()
    assert result.tool_records == []
    assert (result.model, result.input_tokens, result.output_tokens) == ("test-model", 9, 4)
    assert "PRIVATE" not in json.dumps(payloads)
    assert payloads[0]["tools"][0]["function"]["name"]
    assert "fake-test-key" not in repr(settings)


def test_private_tool_results_are_rendered_locally_without_second_request(monkeypatch, settings, user):
    payloads = mock_provider(monkeypatch, [completion(calls=[call()])])
    execute = Mock(return_value={"total": 1, "items": [{"code": "CAM-PRIVATE", "name": "PRIVATE LOCATION",
        "status": "offline", "site_name": "PRIVATE SITE"}], "source_url": "/dashboard/cameras"})
    result = answer(settings, user, execute)
    assert "CAM-PRIVATE" in result.content
    assert len(payloads) == 1
    assert "PRIVATE" not in json.dumps(payloads)
    assert result.tool_records[0]["status"] == "completed"


def test_synthetic_opt_in_tool_loop_preserves_ids_reasoning_and_usage(monkeypatch, settings, user):
    settings = replace(settings, chat_llm_share_internal_data=True)
    reasoning = [{"type": "reasoning.text", "text": "synthetic reasoning"}]
    payloads = mock_provider(monkeypatch, [completion(calls=[call()], reasoning_details=reasoning), completion("Synthetic camera response")])
    result = answer(settings, user, Mock(return_value={"total": 0, "items": []}))
    assert len(payloads) == 2
    assert payloads[1]["messages"][-1]["tool_call_id"] == "call-1"
    assert payloads[1]["messages"][-2]["reasoning_details"] == reasoning
    assert result.input_tokens == 18
    assert result.output_tokens == 8


@pytest.mark.parametrize("tool_call", [call("delete_users"), call(arguments={"status": "invalid", "search": None, "limit": 5}),
    call(arguments={"status": None, "search": None, "limit": 100}),
    call(arguments={"status": None, "search": None, "limit": True}),
    call(arguments={"status": None, "search": None}),
    call(arguments={"status": None, "search": None, "limit": 1, "organization_id": "other"}),
    {"id": "call-1", "function": {"name": "list_cameras", "arguments": "not-json"}}])
def test_invalid_tools_never_execute(monkeypatch, settings, user, tool_call):
    mock_provider(monkeypatch, [completion(calls=[tool_call])])
    execute = Mock()
    result = answer(settings, user, execute)
    execute.assert_not_called()
    assert result.tool_records[0]["status"] == "failed"


@pytest.mark.parametrize("code", [401, 402, 403, 429, 500])
def test_provider_errors_are_actionable_without_raw_secrets(monkeypatch, settings, user, code):
    mock_provider(monkeypatch, [httpx.Response(code, json={"error": "fake-test-key private upstream details"})])
    with pytest.raises(chat_llm.ChatProviderError) as error:
        answer(settings, user)
    assert "OpenRouter" in str(error.value)
    assert "fake-test-key" not in str(error.value)
    assert "private upstream" not in str(error.value)


def test_timeout_has_clear_error(monkeypatch, settings, user):
    mock_provider(monkeypatch, [httpx.ReadTimeout("private upstream")])
    with pytest.raises(chat_llm.ChatProviderError, match="quá lâu"):
        answer(settings, user)


def test_tools_are_bounded_and_duplicate_calls_rejected(monkeypatch, settings, user):
    mock_provider(monkeypatch, [completion(calls=[call(), call()])])
    execute = Mock()
    with pytest.raises(chat_llm.ChatProviderError, match="trùng"):
        answer(settings, user, execute)
    execute.assert_not_called()


def test_no_key_greeting_and_unknown_text_do_not_load_dashboard(monkeypatch, user):
    execute = Mock()
    monkeypatch.setattr(chat_service, "_execute_tool", execute)
    for query in ["chào bạn!", "Xin chào", "hi", "cảm ơn bạn", "Hôm nay bạn thế nào?"]:
        text, records, sources = chat_service._local_answer(query, user)
        assert text and not records and not sources
    execute.assert_not_called()


def test_permissions_are_scoped_to_conversation_organization(monkeypatch, user):
    primary = user["memberships"][0]
    primary["permissions"] = ["camera.view"]
    user["memberships"].append({"organization_id": uuid4(), "permissions": ["user.view"], "is_default": False})
    names = chat_service._allowed_tool_names(user)
    assert "list_users" not in names
    reader = Mock(return_value={"cameras": [], "summary": {}})
    monkeypatch.setattr(chat_service.camera_service, "list_infrastructure", reader)
    chat_service._execute_tool("list_cameras", {}, user)
    assert reader.call_args.args[0]["memberships"] == [primary]
    assert "chưa có quyền" in chat_service._local_answer("danh sách người dùng", user)[0]


def test_missing_summary_permissions_are_not_fabricated_as_zero():
    result = chat_service._format_local_result("get_dashboard_summary", {"cameras": {"cameras": 2, "online": 2}}, "")
    assert "Camera: 2" in result
    assert "Cảnh báo" not in result and "Sự cố" not in result


def test_history_masks_internal_answers_before_external_request(monkeypatch, settings):
    monkeypatch.setattr(chat_service, "get_settings", lambda: settings)
    conn = Mock()
    conn.execute.return_value.fetchall.return_value = [
        {"role": "user", "content": "Camera nào offline?", "metadata": {}},
        {"role": "assistant", "content": "PRIVATE RECORD", "metadata": {"external_safe": False}},
        {"role": "assistant", "content": "LEGACY PRIVATE RECORD", "metadata": {}},
        {"role": "assistant", "content": "Chào bạn!", "metadata": {"external_safe": True}},
    ]
    monkeypatch.setattr(chat_service, "connection", lambda: nullcontext(conn))
    history = chat_service._history(uuid4())
    assert "PRIVATE" not in json.dumps(history)
    assert history[-1]["content"] == "Chào bạn!"


def test_provider_failure_does_not_create_or_save_orphan_turn(monkeypatch, settings, user):
    monkeypatch.setattr(chat_service, "get_settings", lambda: settings)
    monkeypatch.setattr(chat_service, "generate_answer", Mock(side_effect=chat_llm.ChatProviderError("Unavailable")))
    connect = Mock()
    save = Mock()
    monkeypatch.setattr(chat_service, "connection", connect)
    monkeypatch.setattr(chat_service, "_save_message", save)
    with pytest.raises(chat_llm.ChatProviderError):
        chat_service.send_message(ChatSendRequest(message="hello"), user)
    connect.assert_not_called()
    save.assert_not_called()


def test_success_persists_model_tokens_and_conversation(monkeypatch, settings, user):
    monkeypatch.setattr(chat_service, "get_settings", lambda: settings)
    monkeypatch.setattr(chat_service, "generate_answer", Mock(return_value=chat_llm.LLMAnswer("Chào bạn!", "test-model", 9, 4, [])))
    conn = Mock()
    conversation_id = uuid4()
    monkeypatch.setattr(chat_service, "connection", lambda: nullcontext(conn))
    monkeypatch.setattr(chat_service, "_create_conversation", lambda *args: conversation_id)
    save = Mock(side_effect=[{"id": uuid4()}, {"id": uuid4()}])
    monkeypatch.setattr(chat_service, "_save_message", save)
    result = chat_service.send_message(ChatSendRequest(message="hello\nthere"), user)
    assert result["mode"] == "openrouter"
    assert result["conversation_id"] == conversation_id
    assert save.call_args_list[0].args[3] == "hello\nthere"
    assert save.call_args_list[1].args[4:7] == ("test-model", 9, 4)
    assert save.call_args_list[1].args[-1]["external_safe"] is True

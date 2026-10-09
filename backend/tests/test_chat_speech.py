from contextlib import nullcontext
from dataclasses import replace
import io
import json
from unittest.mock import Mock, patch
from uuid import uuid4
import wave

from fastapi.testclient import TestClient
import httpx
import pytest

from app.api.chat import chat_user
from app.chat_schemas import ChatSpeechRequest
from app.config import get_settings
from app.main import app
from app.services import chat_speech
from app.services import ai_observability
from app.services.chat_llm import ChatProviderError
from app.services.chat_service import ChatAccessError, ChatNotFoundError


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setattr(ai_observability, 'record_provider_event', Mock())
    value = replace(get_settings(), openrouter_api_key="fake-test-key", chat_tts_enabled=True, chat_tts_share_internal_data=False)
    monkeypatch.setattr(chat_speech, "get_settings", lambda: value)
    return value


@pytest.fixture
def user():
    return {"id": uuid4(), "memberships": [{"organization_id": uuid4(), "is_default": True}]}


def provider(monkeypatch, response):
    payloads = []
    original = httpx.Client
    def handler(request):
        assert str(request.url) == "https://openrouter.ai/api/v1/audio/speech"
        assert request.headers["Authorization"] == "Bearer fake-test-key"
        payloads.append(json.loads(request.content))
        if isinstance(response, Exception):
            raise response
        return response
    monkeypatch.setattr(chat_speech.httpx, "Client", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    return payloads


def message(monkeypatch, row):
    conn = Mock()
    conn.execute.return_value.fetchone.return_value = row
    monkeypatch.setattr(chat_speech, "connection", lambda: nullcontext(conn))
    return conn


@pytest.mark.parametrize("gender,voice", [("female", "Kore"), ("male", "Charon")])
def test_preview_generates_bilingual_voice_and_wraps_pcm_as_playable_wav(monkeypatch, settings, gender, voice):
    payloads = provider(monkeypatch, httpx.Response(200, headers={"Content-Type": "audio/pcm"}, content=b"\0\0" * 24000))
    connect = Mock(side_effect=AssertionError("Preview must not access database"))
    monkeypatch.setattr(chat_speech, "connection", connect)
    audio, mime = chat_speech.generate_speech(ChatSpeechRequest(voice=gender), {})
    assert mime == "audio/wav"
    with wave.open(io.BytesIO(audio)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (1, 2, 24000, 24000)
    assert payloads[0]["voice"] == voice
    assert payloads[0]["response_format"] == "pcm"
    measurement = ai_observability.record_provider_event.call_args.args[1]
    assert measurement['audio_seconds'] == 1
    assert measurement['status'] == 'completed' and measurement['input_characters'] > 0
    assert measurement['first_byte_ms'] <= measurement['latency_ms']
    assert "Xin chào" in payloads[0]["input"] and "Hello" in payloads[0]["input"]
    connect.assert_not_called()


def test_reads_only_owned_assistant_message_and_sends_clean_content(monkeypatch, settings, user):
    conn = message(monkeypatch, {"content": "**Xin chào** [Camera](https://example.test)\n- Hello!", "metadata": {"external_safe": True}})
    payloads = provider(monkeypatch, httpx.Response(200, headers={"Content-Type": "audio/pcm"}, content=b"\0\0" * 2))
    identifier = uuid4()
    chat_speech.generate_speech(ChatSpeechRequest(message_id=identifier), user)
    sql, args = conn.execute.call_args.args
    assert "m.role='assistant'" in sql
    assert args == (identifier, user["id"], user["memberships"][0]["organization_id"])
    assert payloads[0]["input"] == "Xin chào Camera Hello!"


@pytest.mark.parametrize("metadata", [{}, {"external_safe": False}, None])
def test_internal_and_legacy_messages_never_reach_tts_without_approval(monkeypatch, settings, user, metadata):
    message(monkeypatch, {"content": "PRIVATE RECORD", "metadata": metadata})
    client = Mock(side_effect=AssertionError("No provider request allowed"))
    monkeypatch.setattr(chat_speech.httpx, "Client", client)
    with pytest.raises(ChatAccessError, match="dữ liệu nội bộ"):
        chat_speech.generate_speech(ChatSpeechRequest(message_id=uuid4()), user)
    client.assert_not_called()


def test_missing_or_other_users_message_is_not_read(monkeypatch, settings, user):
    message(monkeypatch, None)
    with pytest.raises(ChatNotFoundError):
        chat_speech.generate_speech(ChatSpeechRequest(message_id=uuid4()), user)


def test_synthetic_opt_in_is_required_to_read_internal_content(monkeypatch, settings, user):
    monkeypatch.setattr(chat_speech, "get_settings", lambda: replace(settings, chat_tts_share_internal_data=True))
    message(monkeypatch, {"content": "Synthetic internal sample", "metadata": {}})
    payloads = provider(monkeypatch, httpx.Response(200, headers={"Content-Type": "audio/pcm"}, content=b"\0\0" * 2))
    chat_speech.generate_speech(ChatSpeechRequest(message_id=uuid4()), user)
    assert payloads[0]["input"] == "Synthetic internal sample"


@pytest.mark.parametrize("code", [400, 401, 402, 404, 429, 500])
def test_provider_failure_never_exposes_raw_upstream_message(monkeypatch, settings, code):
    provider(monkeypatch, httpx.Response(code, json={"error": "fake-test-key"}))
    with pytest.raises(ChatProviderError) as exc:
        chat_speech.generate_speech(ChatSpeechRequest(), {})
    assert "fake-test-key" not in str(exc.value)


@pytest.mark.parametrize("mime,content", [("application/json", b"{}"), ("audio/pcm", b""), ("audio/pcm", b"x")])
def test_invalid_audio_is_not_delivered(monkeypatch, settings, mime, content):
    provider(monkeypatch, httpx.Response(200, headers={"Content-Type": mime}, content=content))
    with pytest.raises(ChatProviderError):
        chat_speech.generate_speech(ChatSpeechRequest(), {})


def test_timeout_reports_voice_error(monkeypatch, settings):
    provider(monkeypatch, httpx.ReadTimeout("private upstream"))
    with pytest.raises(ChatProviderError, match="quá nhiều thời gian"):
        chat_speech.generate_speech(ChatSpeechRequest(), {})


def test_speech_route_returns_audio_with_no_store_and_rejects_invalid_voice(monkeypatch, settings):
    app.dependency_overrides[chat_user] = lambda: {"id": uuid4()}
    monkeypatch.setattr("app.api.chat.generate_speech", lambda *args: (b"RIFF-test", "audio/wav"))
    try:
        with patch("app.database.database.initialize_database", side_effect=RuntimeError("offline")):
            with TestClient(app) as client:
                response = client.post("/api/chat/speech", json={"voice": "male"})
                invalid = client.post("/api/chat/speech", json={"voice": "arbitrary-voice"})
        assert response.status_code == 200
        assert response.content == b"RIFF-test"
        assert response.headers["content-type"] == "audio/wav"
        assert response.headers["cache-control"] == "no-store"
        assert invalid.status_code == 422
    finally:
        app.dependency_overrides.pop(chat_user, None)

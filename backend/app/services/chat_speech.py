from __future__ import annotations

import io
import re
import wave
import time
from typing import Any

import httpx

from app.chat_schemas import ChatSpeechRequest
from app.config import get_settings
from app.database.database import connection
from app.services.chat_llm import ChatProviderError, _provider_error
from app.services.chat_service import ChatAccessError, ChatNotFoundError, _primary_membership
from app.services import ai_observability


VOICES = {"female": "Kore", "male": "Charon"}
PREVIEW_TEXT = "Xin chào! Mình là trợ lý AI của bạn. Hello! I am your AI assistant."
MAX_AUDIO_BYTES = 15 * 1024 * 1024


def spoken_text(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " Đoạn mã được hiển thị trong tin nhắn. ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^[#>\s]*[-*•]\s*", "", text, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", re.sub(r"[#*_`~]", "", text)).strip()


def generate_speech(body: ChatSpeechRequest, user: dict[str, Any]) -> tuple[bytes, str]:
    settings = get_settings()
    if not settings.openrouter_api_key or not settings.chat_tts_enabled:
        raise ChatProviderError("Giọng AI chưa được cấu hình ở backend.")
    text = PREVIEW_TEXT
    if body.message_id is not None:
        membership = _primary_membership(user)
        with connection() as conn:
            row = conn.execute(
                """SELECT m.content,m.metadata FROM safety.chat_messages m
                   JOIN safety.chat_conversations c ON c.id=m.conversation_id
                   WHERE m.id=%s AND m.role='assistant' AND c.user_id=%s AND c.organization_id=%s""",
                (body.message_id, user["id"], membership["organization_id"]),
            ).fetchone()
        if row is None:
            raise ChatNotFoundError("Không tìm thấy câu trả lời để đọc.")
        if not settings.chat_tts_share_internal_data and not (row.get("metadata") or {}).get("external_safe"):
            raise ChatAccessError("Câu trả lời chứa dữ liệu nội bộ. Chủ hệ thống cần cho phép gửi nội dung này tới OpenRouter/Google để tạo giọng AI.")
        text = spoken_text(row["content"])
    if not text:
        raise ValueError("Tin nhắn không có nội dung để đọc.")
    if len(text) > 12000:
        raise ValueError("Câu trả lời quá dài để đọc một lần. Hãy yêu cầu trợ lý tóm tắt ngắn hơn.")
    started = time.perf_counter()
    measurement = {'service': 'tts', 'model': settings.chat_tts_model,
                   'status': 'failed', 'input_characters': len(text)}
    try:
        with httpx.Client(
            base_url="https://openrouter.ai/api/v1/",
            headers={"Authorization": "Bearer " + settings.openrouter_api_key,
                     "X-OpenRouter-Title": "AI Safety Monitoring"},
            timeout=httpx.Timeout(90, connect=10), follow_redirects=False,
        ) as client:
            with client.stream("POST", "audio/speech", json={
                "model": settings.chat_tts_model, "input": text,
                "voice": VOICES[body.voice], "response_format": "pcm",
            }) as response:
                measurement['provider_request_id'] = response.headers.get('x-generation-id')
                if response.status_code >= 400:
                    measurement['error_code'] = response.status_code
                    if response.status_code in {400, 404}:
                        raise ChatProviderError("OpenRouter chưa hỗ trợ model hoặc giọng đọc này. Hãy kiểm tra cấu hình TTS.")
                    raise _provider_error(response.status_code)
                media_type = response.headers.get("content-type", "").split(";")[0].lower()
                if media_type not in {"audio/pcm", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"}:
                    raise ChatProviderError("OpenRouter không trả về âm thanh hợp lệ.")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    if chunk and 'first_byte_ms' not in measurement:
                        measurement['first_byte_ms'] = (time.perf_counter() - started) * 1000
                    size += len(chunk)
                    if size > MAX_AUDIO_BYTES:
                        raise ChatProviderError("Âm thanh quá dài. Hãy yêu cầu trợ lý trả lời ngắn hơn.")
                    chunks.append(chunk)
                audio = b"".join(chunks)
                if not audio:
                    raise ChatProviderError("OpenRouter trả về âm thanh trống. Bạn hãy thử lại.")
                if media_type == "audio/pcm":
                    # Gemini emits signed 16-bit little-endian PCM, mono, 24 kHz.
                    # Wrap it as WAV so HTMLAudioElement can decode it reliably.
                    if len(audio) % 2:
                        raise ChatProviderError("OpenRouter trả về âm thanh PCM không hợp lệ.")
                    buffer = io.BytesIO()
                    with wave.open(buffer, "wb") as wav:
                        wav.setnchannels(1)
                        wav.setsampwidth(2)
                        wav.setframerate(24000)
                        wav.writeframes(audio)
                    measurement.update(status='completed', audio_seconds=len(audio) / 48000)
                    return buffer.getvalue(), "audio/wav"
                measurement['status'] = 'completed'
                if media_type in {'audio/wav','audio/x-wav'}:
                    try:
                        with wave.open(io.BytesIO(audio), 'rb') as wav:
                            measurement['audio_seconds'] = wav.getnframes() / wav.getframerate()
                    except (wave.Error, EOFError): pass
                return audio, media_type
    except httpx.TimeoutException as exc:
        raise ChatProviderError("Tạo giọng đọc mất quá nhiều thời gian. Bạn hãy thử lại.") from exc
    except httpx.RequestError as exc:
        raise ChatProviderError("Không kết nối được dịch vụ giọng đọc OpenRouter.") from exc
    finally:
        measurement['latency_ms'] = (time.perf_counter() - started) * 1000
        ai_observability.record_provider_event(user, measurement)

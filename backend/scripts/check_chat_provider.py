"""Check OpenRouter with a greeting only, without database access or internal data."""
from dataclasses import replace
from pathlib import Path
import sys

from dotenv import load_dotenv

backend_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(backend_root))
load_dotenv(backend_root / ".env")

from app.config import get_settings
from app.services.chat_llm import ChatProviderError, generate_answer


def main() -> int:
    # Windows terminals may otherwise use a legacy encoding for Vietnamese.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    settings = replace(get_settings(), chat_max_output_tokens=256, chat_llm_share_internal_data=False)
    if not settings.openrouter_api_key:
        print("Chưa có OPENROUTER_API_KEY trong backend/.env. Điền key vào file, không gửi qua chat.")
        return 1
    try:
        response = generate_answer(
            [{"role": "user", "content": "Chào bạn! Hãy chào lại ngắn gọn trong một câu."}],
            {}, [], lambda *_: {}, settings, lambda *_: "",
        )
    except ChatProviderError as exc:
        print(str(exc))
        return 1
    print(f"Kết nối OpenRouter thành công. Model: {response.model}")
    print(response.content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

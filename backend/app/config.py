from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


def _env_flag(name: str, default: bool) -> bool:
    fallback = "true" if default else "false"
    return os.getenv(name, fallback).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    project_root: Path
    backend_root: Path
    manifest_path: Path
    dataset_root: Path
    output_dir: Path
    video_storage_dir: Path
    checkpoint_storage_dir: Path
    database_url: str
    frontend_origins: tuple[str, ...]
    jwt_secret: str
    jwt_issuer: str
    access_token_minutes: int
    refresh_token_days: int
    require_email_verification: bool
    device: str
    detection_confidence: float
    rf_detr_inference_fps: float
    rf_detr_input_size: int
    person_locator_tiling: bool
    person_locator_input_size: int
    preload_models: bool
    ai_cpu_threads: int
    ai_max_concurrent_inference: int
    video_output_max_width: int
    video_encode_preset: str
    openrouter_api_key: str = field(default="", repr=False)
    openrouter_model: str = "google/gemini-2.5-flash"
    chat_timeout_seconds: float = 45
    chat_max_output_tokens: int = 1200
    chat_max_tool_rounds: int = 4
    chat_history_messages: int = 16
    chat_temperature: float = 0.65
    chat_llm_share_internal_data: bool = False
    chat_tts_model: str = "google/gemini-3.8-flash-tts"
    chat_tts_enabled: bool = True
    chat_tts_share_internal_data: bool = False

    @property
    def migration_path(self) -> Path:
        return self.backend_root / "migrations" / "001_init.sql"

    def ensure_storage(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.video_storage_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_storage_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    backend_root = Path(__file__).resolve().parents[1]
    project_root = backend_root.parent
    storage_root = project_root / "storage"
    origins = tuple(
        origin.strip()
        for origin in os.getenv(
            "FRONTEND_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    )

    return Settings(
        project_root=project_root,
        backend_root=backend_root,
        manifest_path=Path(
            os.getenv(
                "VIDEO_MANIFEST_PATH",
                project_root / "outputs" / "video_audit" / "video_manifest_FINAL_kaggle.csv",
            )
        ).resolve(),
        dataset_root=Path(os.getenv("VIDEO_DATASET_ROOT", project_root / "Datasets" / "Safe_Unsafe")).resolve(),
        output_dir=Path(os.getenv("OUTPUT_DIR", storage_root / "outputs")).resolve(),
        video_storage_dir=Path(os.getenv("VIDEO_STORAGE_DIR", storage_root / "videos")).resolve(),
        checkpoint_storage_dir=Path(os.getenv("CHECKPOINT_STORAGE_DIR", storage_root / "checkpoints")).resolve(),
        database_url=os.getenv(
            "DATABASE_URL",
            "postgresql://postgres:postgres@localhost:5432/safety_db",
        ),
        frontend_origins=origins,
        jwt_secret=os.getenv(
            "JWT_SECRET",
            "development-only-change-this-secret-before-production",
        ),
        jwt_issuer=os.getenv("JWT_ISSUER", "ai-safety-monitoring"),
        access_token_minutes=int(os.getenv("ACCESS_TOKEN_MINUTES", "15")),
        refresh_token_days=int(os.getenv("REFRESH_TOKEN_DAYS", "30")),
        require_email_verification=os.getenv(
            "AUTH_REQUIRE_EMAIL_VERIFICATION", "false"
        ).strip().lower() in {"1", "true", "yes", "on"},
        device=os.getenv("AI_DEVICE", "auto"),
        detection_confidence=float(os.getenv("DETECTION_CONFIDENCE", "0.20")),
        rf_detr_inference_fps=float(os.getenv("RF_DETR_INFERENCE_FPS", "2")),
        rf_detr_input_size=int(os.getenv("RF_DETR_INPUT_SIZE", "384")),
        person_locator_tiling=_env_flag("PERSON_LOCATOR_TILING", False),
        person_locator_input_size=int(os.getenv("PERSON_LOCATOR_INPUT_SIZE", "960")),
        preload_models=_env_flag("AI_PRELOAD_MODELS", True),
        ai_cpu_threads=max(1, int(os.getenv("AI_CPU_THREADS", str(min(4, max(1, (os.cpu_count() or 4) // 2)))))),
        ai_max_concurrent_inference=int(os.getenv("AI_MAX_CONCURRENT_INFERENCE", "1")),
        video_output_max_width=int(os.getenv("VIDEO_OUTPUT_MAX_WIDTH", "1280")),
        video_encode_preset=os.getenv("VIDEO_ENCODE_PRESET", "ultrafast").strip(),
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY", "").strip(),
        openrouter_model=os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash").strip() or "google/gemini-2.5-flash",
        chat_timeout_seconds=max(5, min(float(os.getenv("CHAT_TIMEOUT_SECONDS", "45")), 120)),
        chat_max_output_tokens=max(128, min(int(os.getenv("CHAT_MAX_OUTPUT_TOKENS", "1200")), 4096)),
        chat_max_tool_rounds=max(1, min(int(os.getenv("CHAT_MAX_TOOL_ROUNDS", "4")), 6)),
        chat_history_messages=max(2, min(int(os.getenv("CHAT_HISTORY_MESSAGES", "16")), 40)),
        chat_temperature=max(0, min(float(os.getenv("CHAT_TEMPERATURE", "0.65")), 1)),
        chat_llm_share_internal_data=_env_flag("CHAT_LLM_SHARE_INTERNAL_DATA", False),
        chat_tts_model=os.getenv("CHAT_TTS_MODEL", "google/gemini-3.8-flash-tts").strip() or "google/gemini-3.8-flash-tts",
        chat_tts_enabled=_env_flag("CHAT_TTS_ENABLED", True),
        chat_tts_share_internal_data=_env_flag("CHAT_TTS_SHARE_INTERNAL_DATA", False),
    )

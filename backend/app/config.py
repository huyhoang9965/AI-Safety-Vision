from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


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
    device: str
    detection_confidence: float
    rf_detr_inference_fps: float
    rf_detr_input_size: int

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
            "postgresql://postgres:postgres@localhost:5432/ai_safety_monitoring",
        ),
        frontend_origins=origins,
        device=os.getenv("AI_DEVICE", "auto"),
        detection_confidence=float(os.getenv("DETECTION_CONFIDENCE", "0.20")),
        rf_detr_inference_fps=float(os.getenv("RF_DETR_INFERENCE_FPS", "1.0")),
        rf_detr_input_size=int(os.getenv("RF_DETR_INPUT_SIZE", "512")),
    )

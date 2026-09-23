from __future__ import annotations

import importlib.util
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.config import get_settings
from app.models.base import ModelAdapter, ModelNotConnectedError
from app.models.rfdetr import RFDETRDetector
from app.models.videomae import VideoMAEClassifier


@dataclass(frozen=True)
class ModelSpec:
    name: str
    type: str
    version: str
    weight_path: Path | None
    factory: Callable[[], ModelAdapter]
    forced_disconnected_reason: str | None = None
    dependency: str | None = None

    def connection_status(self) -> tuple[bool, str]:
        if self.forced_disconnected_reason:
            return False, self.forced_disconnected_reason
        if self.weight_path is None or not self.weight_path.is_file():
            return False, "Model weight not connected"
        if self.dependency and importlib.util.find_spec(self.dependency) is None:
            return False, f"Model weight not connected: missing dependency {self.dependency}"
        if self.name == 'RF-DETR':
            if importlib.util.find_spec('ultralytics') is None:
                return False, 'Missing person locator dependency: ultralytics'
            if not (get_settings().checkpoint_storage_dir / 'yolov8s.pt').is_file():
                return False, 'Missing person locator checkpoint: storage/checkpoints/yolov8s.pt'
        return True, "Ready for lazy loading"


class ModelRegistry:
    def __init__(self):
        root = get_settings().project_root
        model_root = root / "models"
        self._specs = {
            "RF-DETR": ModelSpec(
                name="RF-DETR",
                type="detection",
                version="RFDETRLarge 1.10.1",
                weight_path=model_root / "RF-DETR" / "checkpoint_best_total.pth",
                factory=lambda: RFDETRDetector(model_root / "RF-DETR" / "checkpoint_best_total.pth"),
                dependency="rfdetr",
            ),
            "VideoMAE": ModelSpec(
                name="VideoMAE",
                type="classification",
                version="best_stage3.pt",
                weight_path=model_root / "videomae_stage1" / "best_stage3.pt",
                factory=lambda: VideoMAEClassifier(model_root / "videomae_stage1" / "best_stage3.pt"),
                dependency="transformers",
            ),
        }
        self._loaded: dict[str, ModelAdapter] = {}
        self._lock = threading.Lock()

    def specs(self) -> tuple[ModelSpec, ...]:
        return tuple(self._specs.values())

    def get_spec(self, model_name: str) -> ModelSpec:
        try:
            return self._specs[model_name]
        except KeyError as exc:
            raise KeyError(f"Unsupported model: {model_name}") from exc

    def get_adapter(self, model_name: str) -> tuple[ModelSpec, ModelAdapter]:
        spec = self.get_spec(model_name)
        connected, reason = spec.connection_status()
        if not connected:
            raise ModelNotConnectedError(reason)

        with self._lock:
            if spec.name not in self._loaded:
                self._loaded[spec.name] = spec.factory()
            return spec, self._loaded[spec.name]

    def is_loaded(self, model_name: str) -> bool:
        return model_name in self._loaded

    def catalog_rows(self) -> list[dict[str, str | None]]:
        return [
            {
                "name": spec.name,
                "type": spec.type,
                "version": spec.version,
                "weight_path": str(spec.weight_path) if spec.weight_path else None,
            }
            for spec in self.specs()
        ]


registry = ModelRegistry()

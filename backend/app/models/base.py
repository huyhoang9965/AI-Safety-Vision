from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol


class ModelNotConnectedError(RuntimeError):
    public_message = "Model weight not connected"

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class InferenceOutput:
    type: str
    prediction: str
    confidence: float
    output_path: Path | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    predictions: list[dict[str, Any]] = field(default_factory=list)
    detections: list[dict[str, Any]] = field(default_factory=list)


class ModelAdapter(Protocol):
    def warmup(self) -> None: ...

    def infer(self, video_path: Path, output_dir: Path) -> InferenceOutput: ...

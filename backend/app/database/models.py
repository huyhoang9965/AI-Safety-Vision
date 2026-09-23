from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DatabaseVideo:
    id: int
    filename: str
    filepath: Path
    split: str
    duration: float | None


@dataclass(frozen=True)
class DatabaseModel:
    id: int
    name: str
    type: str
    version: str
    weight_path: str | None

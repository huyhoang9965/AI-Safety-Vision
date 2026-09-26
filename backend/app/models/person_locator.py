"""Stationary/occluded person localization; never infers PPE from motion."""
from __future__ import annotations

from pathlib import Path
import math
from threading import Lock

from app.config import get_settings
from app.models.base import ModelNotConnectedError
from app.models.detection_common import FrameDetection


def box_iou(a, b) -> float:
    intersection = max(0, min(a.x2, b.x2) - max(a.x1, b.x1)) * max(0, min(a.y2, b.y2) - max(a.y1, b.y1))
    union = (a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - intersection
    return intersection / union if union > 0 else 0.0


def tile_windows(width: int, height: int):
    """Overlapping windows cover the entire frame, including far image edges."""
    tile_w, tile_h = min(width, 960), min(height, 720)
    def starts(size, tile):
        count = math.ceil((size - tile) / (tile * .75)) + 1
        return [round(i * (size-tile) / max(1, count-1)) for i in range(count)]
    return [(x, y, x+tile_w, y+tile_h) for y in starts(height,tile_h) for x in starts(width,tile_w)]


def inference_windows(width: int, height: int, use_tiles: bool):
    full_frame = (0, 0, width, height)
    if not use_tiles:
        return [full_frame]
    return list(dict.fromkeys([full_frame, *tile_windows(width, height)]))


class PersonLocator:
    def __init__(self, weight_path: Path):
        self.weight_path = weight_path
        self._model = None
        self._device = "cpu"
        self._load_lock = Lock()
        self._warmed = False

    def _load(self):
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:
                return self._model
            if not self.weight_path.is_file():
                raise ModelNotConnectedError(f"Person locator checkpoint missing: {self.weight_path}")
            from ultralytics import YOLO
            import torch

            self._model = YOLO(str(self.weight_path))
            if self._model.names.get(0) != "person":
                raise ModelNotConnectedError("Person locator must have COCO person at class 0")
            configured = get_settings().device
            self._device = configured if configured != "auto" else (0 if torch.cuda.is_available() else "cpu")
            if self._device == "cpu":
                torch.set_num_threads(max(1, get_settings().ai_cpu_threads))
            return self._model

    def warmup(self) -> None:
        if self._warmed:
            return
        import numpy as np

        model = self._load()
        size = get_settings().person_locator_input_size
        model.predict(
            np.zeros((size, size, 3), dtype=np.uint8),
            classes=[0], conf=.30, imgsz=size, verbose=False, device=self._device,
        )
        self._warmed = True

    def predict(self, frame) -> list[FrameDetection]:
        model = self._load()
        settings = get_settings()
        h, w = frame.shape[:2]
        windows = inference_windows(w, h, settings.person_locator_tiling)
        people = []
        for x1,y1,x2,y2 in windows:
            result = model.predict(frame[y1:y2,x1:x2], classes=[0], conf=.30,
                                   imgsz=settings.person_locator_input_size,
                                   verbose=False, device=self._device)[0]
            for box in result.boxes:
                a,b,c,d = box.xyxy[0].tolist()
                # Reject people cut by artificial tile edges; adjacent tiles or
                # the full-frame pass see their complete visible extent.
                if ((x1 > 0 and a < 3) or (y1 > 0 and b < 3)
                    or (x2 < w and c > x2-x1-3) or (y2 < h and d > y2-y1-3)):
                    continue
                if c-a < 12 or d-b < 20:
                    continue
                people.append(FrameDetection("Person", float(box.conf.item()),
                                             max(0,a+x1),max(0,b+y1),min(w,c+x1),min(h,d+y1)))
        kept = []
        for person in sorted(people, key=lambda item: item.confidence, reverse=True):
            if not any(box_iou(person, other) > .40 for other in kept):
                kept.append(person)
        return kept

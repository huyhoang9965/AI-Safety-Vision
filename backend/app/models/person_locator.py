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


def calibrated_windows(width, height, regions):
    windows = []
    for region in regions or []:
        if len(region) != 4 or not (0 <= region[0] < region[2] <= 1 and 0 <= region[1] < region[3] <= 1):
            continue
        windows.append(tuple(round(value * size) for value,size in zip(region,[width,height,width,height])))
    return windows


def same_visible_person(a, b):
    if box_iou(a,b) > .40:
        return True
    aw,bw = a.x2-a.x1,b.x2-b.x1
    intersection = max(0,min(a.x2,b.x2)-max(a.x1,b.x1))*max(0,min(a.y2,b.y2)-max(a.y1,b.y1))
    smaller = min(aw*(a.y2-a.y1),bw*(b.y2-b.y1))
    return (intersection/max(1,smaller) >= .80 and min(aw,bw)/max(1,aw,bw) >= .45
        and abs(a.y1-b.y1) <= max(6,min(aw,bw)*.20)
        and abs((a.x1+a.x2-b.x1-b.x2)/2) <= max(6,min(aw,bw)*.30))


def merge_people(people):
    kept = []
    for person in people:
        duplicate = next((i for i,other in enumerate(kept) if same_visible_person(person,other)),None)
        if duplicate is None:
            kept.append(person)
        elif person.y2-person.y1 > kept[duplicate].y2-kept[duplicate].y1:
            # Preserve order/identity while retaining the complete visible body.
            kept[duplicate] = person
    return kept


class PersonLocator:
    def __init__(self, weight_path: Path):
        self.weight_path = weight_path
        self._model = None
        self._device = "cpu"
        self._load_lock = Lock()
        self._warmed = False
        self.reset_body_confirmations()

    def reset_body_confirmations(self):
        self._confirmation_step = 0
        self._confirmed_bodies = []

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

    def _confirm_body(self, frame, person, context_size=None):
        """Require a second contextual view before evaluating a complete body.

        Partial heads behind machines are handled separately: tight crops can
        remove the context needed to recognize them. Full-body candidates must
        still look like the same person, rather than a cylinder or wall fixture.
        """
        h,w = frame.shape[:2]
        pw,ph = person.x2-person.x1,person.y2-person.y1
        if ph / max(1,pw) < 1.7:
            return True
        x1,y1 = max(0,int(person.x1-max(50,pw))),max(0,int(person.y1-max(40,ph*.35)))
        x2,y2 = min(w,int(person.x2+max(50,pw))),min(h,int(person.y2+max(40,ph*.35)))
        views=[(x1,y1,x2,y2,.20)]
        if context_size is not None:
            cw,ch=min(w,context_size[0]),min(h,context_size[1])
            cx=max(0,min(w-cw,round((person.x1+person.x2-cw)/2)))
            cy=max(0,min(h-ch,round((person.y1+person.y2-ch)/2)))
            views.append((cx,cy,cx+cw,cy+ch,.35))
        for x1,y1,x2,y2,confidence in views:
            result = self._load().predict(frame[y1:y2,x1:x2],classes=[0],conf=confidence,
                imgsz=640,verbose=False,device=self._device)[0]
            for box in result.boxes:
                a,b,c,d = box.xyxy[0].tolist()
                other = FrameDetection('Person',float(box.conf.item()),a+x1,b+y1,c+x1,d+y1)
                if (box_iou(person,other) >= .35 and
                    abs(person.y1-other.y1) <= max(12,ph*.20)):
                    return True
        return False

    def predict(self, frame, focus_windows=None, confirm_bodies=False, focus_input_size=None, body_context_size=None) -> list[FrameDetection]:
        model = self._load()
        settings = get_settings()
        h, w = frame.shape[:2]
        if focus_input_size is not None and (not isinstance(focus_input_size,int) or focus_input_size <= 0 or focus_input_size % 32):
            raise ValueError('Person focus input size must be a positive multiple of 32')
        if body_context_size is not None and (len(body_context_size)!=2 or any(not isinstance(v,int) or v<=0 for v in body_context_size)):
            raise ValueError('Person body context must contain two positive pixel dimensions')
        windows = list(dict.fromkeys(inference_windows(w,h,settings.person_locator_tiling)
            + calibrated_windows(w,h,focus_windows)))
        people = []
        for x1,y1,x2,y2 in windows:
            result = model.predict(frame[y1:y2,x1:x2], classes=[0], conf=.30,
                                   imgsz=(focus_input_size or settings.person_locator_input_size)
                                       if (x1,y1,x2,y2) != (0,0,w,h) else settings.person_locator_input_size,
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
        merged = merge_people(people)
        if not confirm_bodies:
            return merged
        self._confirmation_step += 1
        grace = max(1,math.ceil(settings.rf_detr_inference_fps*1.5)) if body_context_size else 0
        self._confirmed_bodies = [(step,box) for step,box in self._confirmed_bodies
            if self._confirmation_step-step <= grace]
        kept=[]
        for person in merged:
            verified = self._confirm_body(frame,person,body_context_size)
            # Briefly retain positive body verification for the same currently
            # detector-visible person. Never carry an old box into an empty
            # frame or let repeated unverified observations renew the grace.
            recent = person.confidence >= .35 and any(
                same_visible_person(person,box) for _,box in self._confirmed_bodies)
            if verified or recent:
                kept.append(person)
            if verified and (person.y2-person.y1)/max(1,person.x2-person.x1) >= 1.7:
                self._confirmed_bodies = [(step,box) for step,box in self._confirmed_bodies
                    if not same_visible_person(person,box)]
                self._confirmed_bodies.append((self._confirmation_step,person))
        return kept

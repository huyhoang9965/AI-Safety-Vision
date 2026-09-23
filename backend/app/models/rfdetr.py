from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import cv2

from app.config import get_settings
from app.models.base import InferenceOutput, ModelNotConnectedError
from app.models.detection_common import FrameDetection, render_detection_video
from app.models.person_locator import PersonLocator, box_iou

PPE_CLASSES = ["Gloves", "Vest", "goggles", "helmet", "mask", "safety_shoe"]


def body_regions(person: FrameDetection):
    """Review regions within the detected visible person, not an extrapolated body."""
    w,h = person.x2-person.x1, person.y2-person.y1
    head_h = min(h*.42, w*.85)
    head = (person.x1+w*.10, person.y1, person.x2-w*.10, person.y1+head_h)
    # A head/shoulders-only detection cannot establish whether a vest is worn.
    torso = None if h/w < 1.7 else (
        person.x1+w*.05, person.y1+head_h, person.x2-w*.05, person.y1+h*.80)
    return head, torso


def in_region(item, region):
    if region is None:
        return False
    x,y = (item.x1+item.x2)/2, (item.y1+item.y2)/2
    return region[0] <= x <= region[2] and region[1] <= y <= region[3]


class RFDETRDetector:
    def __init__(self, weight_path: Path):
        self.weight_path = weight_path
        self._model = None
        self._people = PersonLocator(get_settings().checkpoint_storage_dir / "yolov8s.pt")
        self._reset_tracks()

    def _reset_tracks(self):
        self._tracks = {}
        self._next_id = 1
        self._step = 0

    def _load(self):
        if self._model is not None:
            return self._model
        if not self.weight_path.is_file():
            raise ModelNotConnectedError(f"Checkpoint not found: {self.weight_path}")
        try:
            from rfdetr import RFDETRLarge
            self._model = RFDETRLarge(pretrain_weights=str(self.weight_path), num_classes=len(PPE_CLASSES))
        except Exception as exc:
            raise ModelNotConnectedError(f"RF-DETR checkpoint could not be loaded: {exc}") from exc
        return self._model

    def _person_ppe(self, frame, person):
        h,w = frame.shape[:2]
        pw,ph = person.x2-person.x1, person.y2-person.y1
        x1,y1 = max(0,int(person.x1-pw*.3)), max(0,int(person.y1-ph*.15))
        x2,y2 = min(w,int(person.x2+pw*.3)), min(h,int(person.y2+ph*.15))
        crop = frame[y1:y2,x1:x2]
        size = get_settings().rf_detr_input_size
        if size <= 0 or size % 32:
            raise RuntimeError("RF_DETR_INPUT_SIZE must be a positive multiple of 32")
        raw = self._load().predict(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB),
            threshold=get_settings().detection_confidence, shape=(size,size), include_source_image=False)
        detections = []
        if raw is not None:
            for box, score, class_id in zip(raw.xyxy,raw.confidence,raw.class_id):
                idx = int(class_id)
                if not 0 <= idx < len(PPE_CLASSES):
                    continue
                a,b,c,d = box
                detections.append(FrameDetection(PPE_CLASSES[idx],float(score),
                    float(a+x1),float(b+y1),float(c+x1),float(d+y1),track_id=person.track_id))
        return detections

    def _predict_frame(self, frame) -> list[FrameDetection]:
        self._step += 1
        self._tracks = {key:value for key,value in self._tracks.items() if self._step-value['step'] <= 2}
        used = set()
        results = []
        for found in self._people.predict(frame):
            matches = [(box_iou(found,track['box']),key) for key,track in self._tracks.items() if key not in used]
            overlap, track_id = max(matches,default=(0,None))
            if overlap < .25:
                track_id = self._next_id
                self._next_id += 1
                self._tracks[track_id] = {'box':found,'step':self._step,'missing':{}}
            track = self._tracks[track_id]
            if track['step'] < self._step-1:
                track['missing'] = {}
            used.add(track_id)
            person = replace(found,track_id=track_id)
            track.update(box=person,step=self._step)
            results.append(person)
            ppe = self._person_ppe(frame,person)
            head,torso = body_regions(person)
            # Associate PPE only with the correct region of this detected person.
            ppe = [item for item in ppe if
                   (item.class_name == 'helmet' and in_region(item,head)) or
                   (item.class_name == 'Vest' and in_region(item,torso)) or
                   (item.class_name not in {'helmet','Vest'} and in_region(item,(person.x1,person.y1,person.x2,person.y2)))]
            results.extend(ppe)
            for label, region, present in [
                ('Suspected no helmet',head,any(item.class_name=='helmet' for item in ppe)),
                ('Suspected no vest',torso,any(item.class_name=='Vest' for item in ppe)),
            ]:
                # Visibility at the top edge is unknown; do not accuse a cropped-off head.
                evaluable = region is not None and (label != 'Suspected no helmet' or person.y1 > 2)
                streak = track['missing'].get(label,0)+1 if evaluable and not present else 0
                track['missing'][label] = streak
                if streak >= 2:
                    results.append(FrameDetection(label,person.confidence,*region,is_violation=True,
                        track_id=track_id,evidence_basis='person_detected_ppe_not_observed'))
        return results

    def infer(self, video_path: Path, output_dir: Path) -> InferenceOutput:
        self._load()
        self._reset_tracks()
        output = render_detection_video(video_path,output_dir,'rf-detr',self._predict_frame,
                                        inference_fps=get_settings().rf_detr_inference_fps)
        output.metrics['person_locator'] = 'YOLOv8s COCO + overlapping tiles'
        output.metrics['pipeline_version'] = 'person-v1'
        return output

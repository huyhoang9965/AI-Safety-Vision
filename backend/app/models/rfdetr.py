from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from threading import Lock
from math import ceil
import json
import cv2

from app.config import get_settings
from app.models.base import InferenceOutput, ModelNotConnectedError
from app.models.detection_common import FrameDetection, render_detection_video
from app.models.person_locator import PersonLocator, box_iou
from app.models.visible_person_tracking import head_features, continue_visible_person

PPE_CLASSES = ["Gloves", "Vest", "goggles", "helmet", "mask", "safety_shoe"]
PPE_PIPELINE_VERSION = 'person-v6-focus-scale'


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


def person_match(found, previous):
    overlap = box_iou(found, previous)
    fw, pw = found.x2-found.x1, previous.x2-previous.x1
    intersection = max(0, min(found.x2,previous.x2)-max(found.x1,previous.x1)) * max(0,min(found.y2,previous.y2)-max(found.y1,previous.y1))
    smaller = min(fw*(found.y2-found.y1),pw*(previous.y2-previous.y1))
    contained = intersection / max(1,smaller)
    # Full-body versus partially occluded detections can have a low IoU while
    # the visible head stays in the same place. Never match on a broad ROI.
    if (min(fw,pw)/max(fw,pw,1) >= .45 and contained >= .65
        and abs(found.y1-previous.y1) <= max(8,min(fw,pw)*.25)
        and abs((found.x1+found.x2-previous.x1-previous.x2)/2) <= max(8,min(fw,pw)*.35)):
        overlap = max(overlap,.5+contained*.25)
    return overlap


class RFDETRDetector:
    def __init__(self, weight_path: Path):
        self.weight_path = weight_path
        self._model = None
        self._load_lock = Lock()
        self._people = PersonLocator(get_settings().checkpoint_storage_dir / "yolov8s.pt")
        self._reset_tracks()

    def _reset_tracks(self):
        self._people.reset_body_confirmations()
        self._tracks = {}
        self._next_id = 1
        self._step = 0
        self._track_ttl = max(2,ceil(max(.5,get_settings().rf_detr_inference_fps)*4))
        # A worn vest does not disappear when the detector misses a few frames.
        # Keep positive evidence briefly on this person only, without drawing
        # an old vest box or treating the whole clip as permanently compliant.
        self._vest_grace_steps = max(1,ceil(max(.5,get_settings().rf_detr_inference_fps)*3))
        self._focus_windows = []
        self._visual_tracking_steps = 0
        self._previous_gray = None
        self._confirm_bodies = False
        self._focus_input_size = None
        self._body_context_size = None

    def _load(self):
        if self._model is not None:
            return self._model
        with self._load_lock:
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

    def warmup(self) -> None:
        self._load()
        self._people.warmup()

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
        self._tracks = {key:value for key,value in self._tracks.items() if self._step-value['step'] <= self._track_ttl}
        used = set()
        results = []
        people = list(self._people.predict(frame,focus_windows=self._focus_windows,
            confirm_bodies=self._confirm_bodies,focus_input_size=self._focus_input_size,
            body_context_size=self._body_context_size))
        gray = cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY) if self._visual_tracking_steps else None
        flow_points = {}
        if gray is not None and self._previous_gray is not None:
            for identity,track in self._tracks.items():
                if (track['step'] != self._step-1
                    or self._step-track.get('detected_step',track['step']) > self._visual_tracking_steps
                    or any(person_match(found,track['box']) >= .25 for found in people)):
                    continue
                continued = continue_visible_person(self._previous_gray,gray,track['box'],track.get('points'))
                if continued is not None:
                    person,points = continued
                    people.append(person)
                    flow_points[identity] = points
        for found in people:
            matches = []
            for key, track in self._tracks.items():
                if key in used:
                    continue
                age = self._step-track['step']
                score = person_match(found,track['box'])
                if age <= 2 and track.get('velocity'):
                    dx,dy = track['velocity']
                    previous=track['box']
                    predicted=replace(previous,x1=previous.x1+dx*age,x2=previous.x2+dx*age,
                                      y1=previous.y1+dy*age,y2=previous.y2+dy*age)
                    score=max(score,box_iou(found,predicted))
                if score >= (.25 if age <= 2 else .65):
                    matches.append((score,key))
            overlap, track_id = max(matches,default=(0,None))
            if overlap < .25:
                track_id = self._next_id
                self._next_id += 1
                self._tracks[track_id] = {'box':found,'step':self._step,'missing':{},'ppe_seen':{}}
            track = self._tracks[track_id]
            if track['step'] < self._step-1:
                track['missing'] = {}
            used.add(track_id)
            person = replace(found,track_id=track_id)
            elapsed = self._step-track['step']
            if elapsed > 0:
                previous = track['box']
                velocity = (((person.x1+person.x2)-(previous.x1+previous.x2))/2/elapsed,
                            ((person.y1+person.y2)-(previous.y1+previous.y2))/2/elapsed)
                old_velocity=track.get('velocity',velocity)
                track['velocity']=tuple(old*.35+new*.65 for old,new in zip(old_velocity,velocity))
            track.update(box=person,step=self._step)
            if found.evidence_basis != 'detector_anchored_visual_track':
                track['detected_step'] = self._step
            if gray is not None:
                track['points'] = flow_points.get(track_id) if track_id in flow_points else head_features(gray,person)
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
                if present:
                    track['ppe_seen'][label] = self._step
                recently_seen = (label == 'Suspected no vest'
                    and label in track['ppe_seen']
                    and self._step-track['ppe_seen'][label] <= self._vest_grace_steps)
                # Visibility at the top edge is unknown; do not accuse a cropped-off head.
                evaluable = region is not None and (label != 'Suspected no helmet' or person.y1 > 2)
                streak = track['missing'].get(label,0)+1 if evaluable and not present and not recently_seen else 0
                track['missing'][label] = streak
                if streak >= 2:
                    results.append(FrameDetection(label,person.confidence,*region,is_violation=True,
                        track_id=track_id,evidence_basis='person_detected_ppe_not_observed'))
        self._previous_gray = gray
        return results

    def infer(self, video_path: Path, output_dir: Path) -> InferenceOutput:
        self._load()
        self._reset_tracks()
        presets = json.loads((get_settings().project_root/'web/lib/demo-camera-presets.json').read_text(encoding='utf-8'))
        preset = next((row for row in presets if video_path.name in row['filenames']),{})
        preset = {**preset,**preset.get('clip_views',{}).get(video_path.name,{})}
        self._focus_windows = preset.get('person_focus',[])
        self._confirm_bodies = bool(preset.get('confirm_person_bodies',False))
        self._focus_input_size = preset.get('person_focus_input_size')
        self._body_context_size = preset.get('person_body_context_size')
        self._visual_tracking_steps = max(0,ceil(float(preset.get('person_tracking_seconds',0))*get_settings().rf_detr_inference_fps))
        output = render_detection_video(video_path,output_dir,'rf-detr',self._predict_frame,
                                        inference_fps=get_settings().rf_detr_inference_fps)
        output.metrics['person_locator'] = (
            'YOLOv8s COCO + overlapping tiles'
            if get_settings().person_locator_tiling
            else 'YOLOv8s COCO + single full-frame pass'
        )
        output.metrics['person_locator_tiling'] = get_settings().person_locator_tiling
        output.metrics['person_locator_input_size'] = get_settings().person_locator_input_size
        output.metrics['pipeline_version'] = PPE_PIPELINE_VERSION
        output.metrics['vest_positive_memory_seconds'] = 3
        output.metrics['person_focus_windows'] = self._focus_windows
        output.metrics['person_visual_tracking_seconds'] = float(preset.get('person_tracking_seconds',0))
        output.metrics['person_body_confirmation'] = self._confirm_bodies
        output.metrics['person_focus_input_size'] = self._focus_input_size
        output.metrics['person_body_context_size'] = self._body_context_size
        return output

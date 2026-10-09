"""Ground clip classifications in visible objects before publishing alerts.

VideoMAE classifies a whole clip; it does not supply spatial bounding boxes.
Walkway rules apply only to the calibrated demo view. Forklift load warnings
remain suspected overloads: a camera cannot measure payload weight.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from threading import Lock

import cv2
import numpy as np

from app.config import get_settings
from app.models.base import InferenceOutput

PIPELINE_VERSION = "grounded-behavior-v4-panel-context"
_locator_lock = Lock()


@lru_cache(maxsize=1)
def _locator():
    from app.models.person_locator import PersonLocator
    return PersonLocator(get_settings().checkpoint_storage_dir / "yolov8s.pt")


@lru_cache(maxsize=1)
def _presets():
    path = get_settings().project_root / "web/lib/demo-camera-presets.json"
    return json.loads(path.read_text(encoding="utf-8"))


def iou(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection / union if union > 0 else 0.


def deduplicate_evidence(events):
    """Keep separate people/errors, merge duplicate boxes or a repeated track."""
    kept = []
    for event in events:
        if not isinstance(event, dict):
            continue
        duplicate = False
        for prior in kept:
            if prior.get("class_name") != event.get("class_name"):
                continue
            same_track = event.get("track_id") is not None and prior.get("track_id") == event["track_id"]
            same_frame = abs(float(event.get("timestamp_seconds") or 0)-float(prior.get("timestamp_seconds") or 0)) <= 1
            overlapping = event.get("bbox") and prior.get("bbox") and iou(event["bbox"], prior["bbox"]) >= .65
            if same_track or (same_frame and overlapping):
                duplicate = True
                break
        if not duplicate:
            kept.append(event)
    return kept


def green_walkway(frame, polygon):
    """Recover the painted lane, filling occlusions with its convex envelope."""
    h, w = frame.shape[:2]
    region = np.zeros((h, w), np.uint8)
    cv2.fillPoly(region, [np.asarray([(x*w, y*h) for x, y in polygon], np.int32)], 255)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([35, 40, 30]), np.array([95, 255, 255])) & region
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < w*h*.004:
        return None
    return cv2.convexHull(largest)


def outside_walkway(bbox, frame_size, monitored_polygon, lane):
    """Use feet, tolerate border uncertainty, reject cut-off/occluded feet."""
    w, h = frame_size
    x1, y1, x2, y2 = bbox
    if lane is None or y2 >= h-4 or y2-y1 < 45:
        return False
    feet = ((x1+x2)/2, y2)
    monitored = np.asarray([(x*w, y*h) for x, y in monitored_polygon], np.float32)
    if cv2.pointPolygonTest(monitored, feet, False) < 0:
        return False
    return cv2.pointPolygonTest(lane, feet, True) < -max(w*.008, (x2-x1)*.2)


def _features(gray, frame, box):
    x1, y1, x2, y2 = map(int, box)
    mask = np.zeros_like(gray)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    orange = cv2.inRange(hsv, np.array([0, 70, 50]), np.array([30, 255, 255]))
    mask[max(0,y1):y2, max(0,x1):x2] = orange[max(0,y1):y2, max(0,x1):x2]
    return cv2.goodFeaturesToTrack(gray, maxCorners=100, qualityLevel=.02, minDistance=5, mask=mask)


def _orange_load_boxes(frame):
    """Visible load components for this orange-container demo, never static ROIs.

    Components may continue an already detector-anchored track, but cannot seed
    a vehicle warning on their own (stationary containers are not forklifts).
    """
    h,w=frame.shape[:2]
    hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
    mask=cv2.inRange(hsv,np.array([0,70,50]),np.array([22,255,255]))
    kernel=cv2.getStructuringElement(cv2.MORPH_RECT,(max(3,round(w*.005)),max(5,round(h*.018))))
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,kernel)
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[]
    for contour in contours:
        x,y,cw,ch=cv2.boundingRect(contour)
        occupancy=np.count_nonzero(mask[y:y+ch,x:x+cw])/max(1,cw*ch)
        if cw>=w*.035 and ch>=h*.15 and ch/cw>=.9 and occupancy>=.35 and cv2.contourArea(contour)>w*h*.003:
            boxes.append([float(x),float(y),float(x+cw),float(y+ch)])
    return boxes


def _inside_fraction(component, vehicle):
    a,b=component,vehicle
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    return intersection/max(1,(a[2]-a[0])*(a[3]-a[1]))


def _flow_box(previous, gray, points, box):
    if points is None or len(points) < 8:
        return None
    moved, status, _ = cv2.calcOpticalFlowPyrLK(previous, gray, points, None, winSize=(31,31), maxLevel=3)
    if moved is None:
        return None
    backward, back_status, _ = cv2.calcOpticalFlowPyrLK(gray, previous, moved, None, winSize=(31,31), maxLevel=3)
    if backward is None:
        return None
    valid = (status.ravel()==1) & (back_status.ravel()==1) & (np.linalg.norm(points-backward,axis=2).ravel()<2)
    if np.count_nonzero(valid) < 8:
        return None
    transform, inliers = cv2.estimateAffinePartial2D(points[valid], moved[valid], method=cv2.RANSAC, ransacReprojThreshold=3)
    if transform is None or inliers.mean() < .65:
        return None
    scale = np.linalg.norm(transform[:,0])
    if not .80 < scale < 1.20:
        return None
    x1,y1,x2,y2=box
    corners=np.array([[x1,y1,1],[x2,y1,1],[x2,y2,1],[x1,y2,1]]) @ transform.T
    h,w=gray.shape
    updated=[max(0.,corners[:,0].min()),max(0.,corners[:,1].min()),min(w-1.,corners[:,0].max()),min(h-1.,corners[:,1].max())]
    if updated[2]-updated[0] < 30 or updated[3]-updated[1] < 40:
        return None
    return updated, moved[valid]


def verify_behavior(output: InferenceOutput, video_path: Path, camera_code: str | None):
    label = output.prediction
    output.metrics.update(evidence_events=[], overlay_frames=[], verification="not_required", pipeline_version=PIPELINE_VERSION)
    unsafe = {"Safe Walkway Violation", "Carrying Overload with Forklift", "Opened Panel Cover", "Unauthorized Intervention"}
    if label not in unsafe:
        return
    scores = output.metrics.get("class_scores", {})
    runner_up = max((float(v) for k,v in scores.items() if k != label), default=0.)
    threshold = .75 if label == "Carrying Overload with Forklift" else .90
    if output.confidence < threshold or output.confidence-runner_up < .20:
        output.metrics["verification"] = "uncertain_classification"
        return
    preset = next((p for p in _presets() if p["key"] == (camera_code or "").upper() and video_path.name in p["filenames"]), None)
    if preset:
        preset = {**preset,**preset.get('clip_views',{}).get(video_path.name,{})}
    if label == 'Opened Panel Cover' and preset and preset.get('panel_search'):
        from app.services.panel_localization import localize_open_panel
        if preset.get('panel_interior'):
            localize_open_panel(output, video_path, preset['panel_search'],preset['panel_interior'])
        else:
            localize_open_panel(output, video_path, preset['panel_search'])
        return
    if label not in {"Safe Walkway Violation", "Carrying Overload with Forklift"}:
        output.metrics.update(verification="clip_classification", evidence_events=[{
            "class_name":label, "confidence":output.confidence, "basis":"video_classification",
            "verified":True, "track_id":"clip",
        }])
        if label == 'Unauthorized Intervention' and preset and preset.get('panel_interior'):
            from app.services.panel_localization import localize_open_panel
            localize_open_panel(output,video_path,preset['panel_search'],preset['panel_interior'],append=True)
        return
    zone = preset.get("walkway") if preset else None
    if label == "Safe Walkway Violation" and not zone:
        output.metrics["verification"] = "missing_walkway_calibration"
        return
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot read frames for behavior verification")
        fps = float(capture.get(cv2.CAP_PROP_FPS)) or 25.
        w,h = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        interval = max(1,round(fps/4))
        tracks = {}; next_id=1; previous=None; overlay=[]; frame_index=0
        lane=None
        with _locator_lock:
            model=_locator()._load()
            while True:
                ok, frame=capture.read()
                if not ok: break
                if frame_index % interval:
                    frame_index+=1;continue
                timestamp=frame_index/fps
                gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
                if label == "Safe Walkway Violation" and lane is None:
                    lane=green_walkway(frame,zone["lane_search"])
                # Bounding boxes come from the object detector, never the camera ROI.
                classes=[0] if label == "Safe Walkway Violation" else [2,5,7]
                result=model.predict(frame,classes=classes,conf=.30 if classes == [0] else .20,imgsz=960,verbose=False,device=_locator()._device)[0]
                boxes=[b.xyxy[0].tolist() for b in result.boxes]
                load_boxes=[]
                if label == "Carrying Overload with Forklift":
                    load_boxes=_orange_load_boxes(frame) if preset else []
                    candidates=[]; vehicle_boxes=[]
                    for box in boxes:
                        if any(iou(box,prior)>.20 for prior in vehicle_boxes):continue
                        vehicle_boxes.append(box)
                        x1,y1,x2,y2=map(int,box); crop=frame[y1:y2,x1:x2]
                        if not crop.size:continue
                        hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
                        orange=cv2.inRange(hsv,np.array([0,70,50]),np.array([30,255,255]))
                        if np.count_nonzero(orange)/orange.size > .08:
                            contained=[component for component in load_boxes if _inside_fraction(component,box)>.65]
                            load=max(contained,key=lambda component:(component[2]-component[0])*(component[3]-component[1]),default=None)
                            if preset and load is None:
                                continue
                            if load is not None:
                                box=load
                            if not any(iou(box,prior)>.35 for prior in candidates):
                                candidates.append(box)
                    boxes=candidates
                matched=set(); active=[]
                for box in boxes:
                    eligible=[(tid,t) for tid,t in tracks.items() if tid not in matched and timestamp-t["last_seen"] <= 1.5]
                    tid=None
                    if eligible:
                        best_id,best=max(eligible,key=lambda pair:iou(box,pair[1]["bbox"]))
                        if iou(box,best["bbox"])>.15:tid=best_id
                    if tid is None:
                        tid=next_id;next_id+=1
                        tracks[tid]={"samples":[],"bbox":box,"last_seen":timestamp,"points":None,"flow_time":timestamp}
                    track=tracks[tid];track.update(bbox=box,last_seen=timestamp)
                    if label == "Carrying Overload with Forklift":
                        track["points"]=_features(gray,frame,box)
                        track["flow_time"]=timestamp
                    matched.add(tid);active.append(tid)
                if label == "Carrying Overload with Forklift" and previous is not None:
                    for tid,track in tracks.items():
                        # Continue only an uninterrupted, visually validated track.
                        # A detector miss must not erase a still-visible load.
                        if tid in matched or timestamp-track["flow_time"]>.4:continue
                        # The visible load can keep the same semantic track
                        # when COCO loses the cab during a forklift turn.
                        load=max(load_boxes,key=lambda box:iou(box,track["bbox"]),default=None)
                        if load is not None and iou(load,track["bbox"])>.35:
                            track.update(bbox=load,points=_features(gray,frame,load),flow_time=timestamp,last_seen=timestamp)
                            active.append(tid)
                            continue
                        flowed=_flow_box(previous,gray,track["points"],track["bbox"])
                        if flowed:
                            track["bbox"],track["points"]=flowed
                            track["flow_time"]=timestamp
                            track["last_seen"]=timestamp
                            active.append(tid)
                for tid in active:
                    track=tracks[tid];box=track["bbox"]
                    qualifies=label == "Carrying Overload with Forklift" or outside_walkway(box,(w,h),zone["monitored_floor"],lane)
                    if qualifies:
                        row={"frame_index":frame_index,"timestamp_seconds":round(timestamp,3),"bbox":[round(float(v),2) for v in box],"track_id":tid,"class_name":label}
                        track["samples"].append(row)
                        overlay.append(row)
                previous=gray;frame_index+=1
        confirmed=[]
        for tid,track in tracks.items():
            samples=track["samples"]
            # Require a sustained episode and motion; one-frame hits and stationary operators do not alert.
            episode=[];episodes=[]
            for sample in samples:
                if episode and sample["timestamp_seconds"]-episode[-1]["timestamp_seconds"]>.6:
                    episodes.append(episode);episode=[]
                episode.append(sample)
            if episode:episodes.append(episode)
            valid=[]
            for episode in episodes:
                if len(episode)<3 or episode[-1]["timestamp_seconds"]-episode[0]["timestamp_seconds"]<.5:continue
                centers=[((s["bbox"][0]+s["bbox"][2])/2,s["bbox"][3]) for s in episode]
                if max(np.linalg.norm(np.asarray(p)-centers[0]) for p in centers)<w*.008:continue
                valid.extend(episode)
            if not valid:continue
            best=max(valid,key=lambda s:(s["bbox"][2]-s["bbox"][0])*(s["bbox"][3]-s["bbox"][1]))
            confirmed.append({**best,"confidence":output.confidence,"verified":True,
                "basis":"person_feet_outside_painted_walkway" if zone else "video_classification_with_vehicle_tracking",
                "start_seconds":valid[0]["timestamp_seconds"],"end_seconds":valid[-1]["timestamp_seconds"],
                "overlay_frames":valid})
        events=deduplicate_evidence(confirmed)
        output.metrics.update(frame_width=w,frame_height=h,fps=fps,verification="confirmed" if events else "no_visible_violation",
            evidence_events=events,overlay_frames=[row for event in events for row in event["overlay_frames"]])
    finally:
        capture.release()

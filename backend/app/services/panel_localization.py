"""Fit visible cabinet apertures within a calibrated stationary camera view.

The search window identifies the cabinet, never a violation box. Image
components provide boxes and VideoMAE provides the opened/closed class.
"""
import cv2
import numpy as np


def panel_aperture(frame, search, interior=None):
    h, w = frame.shape[:2]
    if len(search) != 4 or not (0 <= search[0] < search[2] <= 1 and 0 <= search[1] < search[3] <= 1):
        return None
    sx, sy, ex, ey = [round(value * size) for value, size in zip(search, [w, h, w, h])]
    crop = frame[sy:ey, sx:ex]
    if not crop.size:
        return None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    if interior is not None:
        # Calibrate the cabinet's physical interior, then fit currently visible
        # dark components. A closed door, blank dark surface or a person in a
        # different part of the image cannot supply this evidence.
        points = np.asarray(interior,dtype=float)
        if points.shape != (4,2) or not np.isfinite(points).all() or np.any(points < 0) or np.any(points > 1):
            return None
        region = np.zeros_like(gray)
        polygon = np.asarray([(round(x*w)-sx,round(y*h)-sy) for x,y in points],np.int32)
        cv2.fillPoly(region,[polygon],255)
        visible = gray[region > 0]
        if visible.size < w*h*.002:
            return None
        dark_fraction = float(np.mean(visible < 30))
        edges = cv2.Canny(gray,30,90)
        if not (.35 <= dark_fraction <= .85) or float(np.mean(edges[region > 0] > 0)) < .025:
            return None
        mask = cv2.inRange(gray,0,30) & region
        mask = cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8)) & region
        contours,_ = cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        contour = max(contours,key=cv2.contourArea)
        x,y,cw,ch = cv2.boundingRect(contour)
        if cv2.contourArea(contour) < visible.size*.18 or cw < w*.025 or ch < h*.07:
            return None
        return [float(sx+x),float(sy+y),float(sx+x+cw),float(sy+y+ch)]
    mask = cv2.inRange(gray, 0, 20)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        occupancy = cv2.contourArea(contour) / max(1, cw * ch)
        if x < 3 or y < 3 or x + cw > crop.shape[1] - 3 or y + ch > crop.shape[0] - 3:
            continue
        if not (cw >= w * .025 and ch >= h * .07 and 1.05 <= ch / cw <= 2.8 and .30 <= occupancy < .97):
            continue
        aperture = gray[y:y + ch, x:x + cw]
        edges = cv2.Canny(aperture, 30, 90)
        if np.count_nonzero(edges) / edges.size < .015:
            continue
        candidates.append((cv2.contourArea(contour), [float(sx + x), float(sy + y), float(sx + x + cw), float(sy + y + ch)]))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def localize_open_panel(output, video_path, search, interior=None, append=False):
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise RuntimeError('Cannot read frames for panel localization')
        fps = float(capture.get(cv2.CAP_PROP_FPS)) or 25.
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        interval = max(1, round(fps / 4))
        buffer, confirmed, previous_box, first_time = [], False, None, 0.
        overlay, best, frame_index = [], None, 0
        from app.services.behavior_verification import iou
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % interval == 0:
                timestamp = frame_index / fps
                box = panel_aperture(frame, search, interior) if interior is not None else panel_aperture(frame, search)
                if box is None or (previous_box is not None and iou(box, previous_box) < .65):
                    buffer, confirmed, previous_box = [], False, None
                if box is not None:
                    if previous_box is None:
                        first_time = timestamp
                    previous_box = box
                    row = dict(class_name='Opened Panel Cover', track_id='clip', timestamp_seconds=round(timestamp, 3),
                               end_seconds=round(timestamp + interval / fps + .04, 3), bbox=box)
                    buffer.append(row)
                    if len(buffer) >= 3 and timestamp - first_time >= .45:
                        if not confirmed:
                            overlay.extend(buffer)
                            confirmed = True
                        else:
                            overlay.append(row)
                        buffer = buffer[-3:]
                        x1, y1, x2, y2 = map(int, box)
                        sharpness = float(cv2.Laplacian(frame[y1:y2, x1:x2], cv2.CV_64F).var())
                        if best is None or sharpness > best[0]:
                            best = (sharpness, dict(class_name='Opened Panel Cover', confidence=None if append else output.confidence,
                                basis='visible_panel_aperture_and_intervention_context' if append else 'video_classification_and_visible_panel_aperture', verified=True,
                                track_id='clip', frame_index=frame_index, timestamp_seconds=round(timestamp, 3), bbox=box))
            frame_index += 1
        events = ([*output.metrics.get('evidence_events',[])] if append else []) + ([best[1]] if best else [])
        output.metrics.update(frame_width=width, frame_height=height, fps=fps, overlay_frames=overlay,
                              evidence_events=events,
                              verification=output.metrics.get('verification') if append else ('localized_panel' if best else 'panel_not_visible'),
                              panel_verification='localized_panel' if best else 'panel_not_visible',
                              localization_method='calibrated_visible_aperture')
    finally:
        capture.release()

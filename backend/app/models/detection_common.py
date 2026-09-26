from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
import logging
from pathlib import Path
import re
from typing import Callable, Sequence
from uuid import uuid4

import cv2

from app.config import get_settings
from app.models.base import InferenceOutput

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FrameDetection:
    class_name: str
    confidence: float
    x1: float
    y1: float
    x2: float
    y2: float
    is_violation: bool = False
    track_id: int | None = None
    evidence_basis: str = 'model_detection'


PredictFrame = Callable[[object], Sequence[FrameDetection]]

COLORS = (
    (83, 138, 237),
    (155, 205, 131),
    (110, 206, 241),
    (216, 160, 98),
    (178, 113, 219),
    (118, 184, 221),
)


def render_detection_video(
    video_path: Path,
    output_dir: Path,
    model_slug: str,
    predict_frame: PredictFrame,
    inference_fps: float | None = None,
) -> InferenceOutput:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open test video: {video_path}")

    fps = float(capture.get(cv2.CAP_PROP_FPS)) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        capture.release()
        raise RuntimeError(f"Invalid video dimensions: {video_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{video_path.stem}_{model_slug}_{uuid4().hex[:10]}.mp4"
    try:
        import av
    except ImportError as exc:
        capture.release()
        raise RuntimeError("PyAV is required to create an H.264 browser-compatible output video") from exc

    container = av.open(str(output_path), mode="w")
    settings = get_settings()
    output_width, output_height = width, height
    if 0 < settings.video_output_max_width < width:
        scale = settings.video_output_max_width / width
        output_width = settings.video_output_max_width
        output_height = max(2, round(height * scale))
        output_width -= output_width % 2
        output_height -= output_height % 2
    stream = container.add_stream("libx264", rate=Fraction(fps).limit_denominator(1000))
    stream.width = output_width
    stream.height = output_height
    stream.pix_fmt = "yuv420p"
    stream.options = {"crf": "24", "preset": settings.video_encode_preset or "ultrafast"}

    peak_counts: Counter[str] = Counter()
    stored_detections: list[dict[str, float | int | str]] = []
    max_confidence = 0.0
    frame_index = 0
    inference_frames = 0
    inference_interval = 1
    if inference_fps is not None and inference_fps > 0:
        inference_interval = max(1, round(fps / inference_fps))
    current_detections: Sequence[FrameDetection] = ()
    best_evidence: dict[tuple[str, int | None], tuple] = {}

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            is_inference_frame = frame_index % inference_interval == 0
            source_frame = frame.copy() if is_inference_frame else None
            if is_inference_frame:
                current_detections = predict_frame(frame)
                inference_frames += 1
                frame_counts = Counter(item.class_name for item in current_detections)
                for class_name, count in frame_counts.items():
                    peak_counts[class_name] = max(peak_counts[class_name], count)

            for index, detection in enumerate(current_detections):
                x1 = max(0, min(width - 1, int(detection.x1)))
                y1 = max(0, min(height - 1, int(detection.y1)))
                x2 = max(0, min(width - 1, int(detection.x2)))
                y2 = max(0, min(height - 1, int(detection.y2)))
                color = (56, 65, 230) if detection.is_violation else COLORS[index % len(COLORS)]
                label = detection.class_name if detection.is_violation else f"{detection.class_name} {detection.confidence:.2f}"
                if detection.track_id is not None:
                    label += f" #{detection.track_id}"

                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2, cv2.LINE_AA)
                (text_width, text_height), baseline = cv2.getTextSize(
                    label, cv2.FONT_HERSHEY_SIMPLEX, 0.52, 1
                )
                label_y = max(text_height + baseline + 4, y1)
                cv2.rectangle(
                    frame,
                    (x1, label_y - text_height - baseline - 6),
                    (min(width - 1, x1 + text_width + 8), label_y),
                    color,
                    -1,
                )
                cv2.putText(
                    frame,
                    label,
                    (x1 + 4, label_y - baseline - 3),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.52,
                    (12, 19, 17),
                    1,
                    cv2.LINE_AA,
                )

                max_confidence = max(max_confidence, detection.confidence)
                if is_inference_frame:
                    stored_detections.append(
                        {
                            "frame_index": frame_index,
                            "class_name": detection.class_name,
                            "confidence": float(detection.confidence),
                            "x1": float(x1),
                            "y1": float(y1),
                            "x2": float(x2),
                            "y2": float(y2),
                            "is_violation": detection.is_violation,
                            "track_id": detection.track_id,
                            "evidence_basis": detection.evidence_basis,
                        }
                    )
                    if detection.is_violation:
                        evidence_key = (detection.class_name, detection.track_id)
                        existing = best_evidence.get(evidence_key)
                        if existing is None or detection.confidence > existing[0]:
                            box_width = max(1, x2 - x1)
                            box_height = max(1, y2 - y1)
                            pad_x = max(72, round(box_width * 0.42))
                            pad_y = max(48, round(box_height * 0.28))
                            crop_x1 = max(0, x1 - pad_x)
                            crop_y1 = max(0, y1 - pad_y)
                            crop_x2 = min(width, x2 + pad_x)
                            crop_y2 = min(height, y2 + pad_y)
                            crop = source_frame[crop_y1:crop_y2, crop_x1:crop_x2].copy()
                            local_x1, local_y1 = x1 - crop_x1, y1 - crop_y1
                            local_x2, local_y2 = x2 - crop_x1, y2 - crop_y1
                            evidence_label = {
                                "Suspected no helmet": "CHECK HELMET",
                                "Suspected no vest": "CHECK VEST",
                                "Suspected no helmet and no vest": "CHECK PPE",
                            }.get(detection.class_name, detection.class_name)
                            cv2.rectangle(
                                crop,
                                (local_x1, local_y1),
                                (local_x2, local_y2),
                                (56, 65, 230),
                                1 if min(box_width, box_height) < 60 else 2,
                                cv2.LINE_AA,
                            )
                            # Fit the label to the evidence crop; never obscure a tiny head.
                            text_width = cv2.getTextSize(evidence_label, cv2.FONT_HERSHEY_SIMPLEX, 1.0, 1)[0][0]
                            evidence_scale = min(0.50, (crop.shape[1]-8) / max(1,text_width))
                            cv2.putText(
                                crop,
                                evidence_label,
                                (4, 18),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                evidence_scale,
                                (56, 65, 230),
                                1,
                                cv2.LINE_AA,
                            )
                            best_evidence[evidence_key] = (detection.confidence, crop, frame_index, [x1,y1,x2,y2])

            encoded_frame = (
                cv2.resize(frame, (output_width, output_height), interpolation=cv2.INTER_AREA)
                if (output_width, output_height) != (width, height)
                else frame
            )
            video_frame = av.VideoFrame.from_ndarray(encoded_frame, format="bgr24")
            for packet in stream.encode(video_frame):
                container.mux(packet)
            frame_index += 1
    finally:
        capture.release()
        for packet in stream.encode():
            container.mux(packet)
        container.close()

    if frame_index == 0:
        output_path.unlink(missing_ok=True)
        raise RuntimeError(f"No readable frames in video: {video_path}")

    top_class = peak_counts.most_common(1)[0][0] if peak_counts else "No PPE detected"
    evidence_images: dict[str, str] = {}
    evidence_events = []
    for (class_name, track_id), (score, crop, evidence_frame, bbox) in best_evidence.items():
        safe_class_name = re.sub(r"[^a-z0-9]+", "-", class_name.lower()).strip("-")
        evidence_path = output_dir / f"{output_path.stem}_{safe_class_name}_{track_id}.jpg"
        try:
            saved = cv2.imwrite(str(evidence_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 98])
        except Exception as exc:
            logger.warning("Could not save PPE evidence crop %s: %s", evidence_path, exc)
            saved = False
        if saved:
            evidence_images[class_name] = f"/results/{evidence_path.name}"
        evidence_events.append({
            'class_name': class_name, 'track_id': track_id,
            'image': f'/results/{evidence_path.name}' if saved else None,
            'frame_index': evidence_frame, 'timestamp_seconds': round(evidence_frame/fps,3),
            'bbox': bbox, 'confidence': None, 'person_confidence': score,
            'basis': 'person_detected_ppe_not_observed',
        })
    return InferenceOutput(
        type="detection",
        prediction=top_class,
        confidence=float(max_confidence),
        output_path=output_path,
        metrics={
            "detection_counts": dict(peak_counts),
            "total_detections": sum(peak_counts.values()),
            "frames_processed": frame_index,
            "inference_frames": inference_frames,
            "inference_fps": round(fps / inference_interval, 3),
            "fps": fps,
            "frame_width": width,
            "frame_height": height,
            "output_width": output_width,
            "output_height": output_height,
            "evidence_images": evidence_images,
            "evidence_events": evidence_events,
        },
        detections=stored_detections,
    )

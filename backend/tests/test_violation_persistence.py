from pathlib import Path
from contextlib import contextmanager
from unittest.mock import Mock, MagicMock

from app.database import database
from app.models.base import InferenceOutput
from app.services.inference_service import _build_violation_candidates
from app.services.video_catalog import ResolvedVideo


def _video() -> ResolvedVideo:
    return ResolvedVideo(
        id=7,
        filename="camera-test.mp4",
        filepath=Path("camera-test.mp4"),
        labels=(),
        duration=10.0,
        width=1920,
        height=1080,
        fps=25.0,
    )


def test_detection_violation_keeps_image_time_and_normalized_box():
    output = InferenceOutput(
        type="detection",
        prediction="Suspected no helmet",
        confidence=0.91,
        metrics={
            "frame_width": 1920,
            "frame_height": 1080,
            "evidence_events": [
                {
                    "class_name": "Suspected no helmet",
                    "track_id": 12,
                    "image": "/results/no-helmet.jpg",
                    "frame_index": 50,
                    "timestamp_seconds": 2.0,
                    "bbox": [192, 108, 576, 540],
                    "person_confidence": 0.91,
                    "basis": "person_detected_ppe_not_observed",
                }
            ],
        },
    )

    candidates = _build_violation_candidates(
        output, _video(), "RF-DETR", "/results/result.mp4", 42
    )

    assert len(candidates) == 1
    event = candidates[0]
    assert event["event_code"] == "SUSPECTED_NO_HELMET"
    assert event["snapshot_url"] == "/results/no-helmet.jpg"
    assert event["deduplication_key"].startswith("demo-video:")
    repeated = _build_violation_candidates(
        output, _video(), "RF-DETR", "/results/result.mp4", 99
    )
    assert repeated[0]["deduplication_key"] == event["deduplication_key"]
    assert event["detected_object"]["bbox_x"] == 0.1
    assert event["detected_object"]["bbox_y"] == 0.1
    assert event["raw_payload"]["evidence"]["timestamp_seconds"] == 2.0


def test_safe_classification_does_not_create_dashboard_event(monkeypatch):
    monkeypatch.setattr(
        "app.services.inference_service._save_video_snapshot",
        lambda *_args: "/results/should-not-be-created.jpg",
    )
    output = InferenceOutput(
        type="classification",
        prediction="Safe Walkway",
        confidence=0.97,
        metrics={
            "class_scores": {"Safe Walkway": 0.97},
            "predicted_classes": ["Safe Walkway"],
        },
    )

    candidates = _build_violation_candidates(
        output, _video(), "VideoMAE", "/api/videos/7/stream", 43
    )

    assert candidates == []
    assert output.metrics["evidence_events"] == []


def test_classification_violation_creates_snapshot_candidate(monkeypatch):
    monkeypatch.setattr(
        "app.services.inference_service._save_video_snapshot",
        lambda *_args: "/results/walkway.jpg",
    )
    output = InferenceOutput(
        type="classification",
        prediction="Safe Walkway Violation",
        confidence=0.88,
        metrics={
            "class_scores": {"Safe Walkway Violation": 0.88},
            "predicted_classes": ["Safe Walkway Violation"],
        },
    )

    candidates = _build_violation_candidates(
        output, _video(), "VideoMAE", "/api/videos/7/stream", 44
    )

    assert len(candidates) == 1
    assert candidates[0]["event_code"] == "SAFE_WALKWAY_VIOLATION"
    assert candidates[0]["snapshot_url"] == "/results/walkway.jpg"
    assert candidates[0]["confidence"] == 0.88


def test_low_confidence_unsafe_classification_still_creates_alert(monkeypatch):
    monkeypatch.setattr(
        "app.services.inference_service._save_video_snapshot",
        lambda *_args: "/results/unsafe.jpg",
    )
    output = InferenceOutput(
        type="classification",
        prediction="Safe Walkway Violation",
        confidence=0.32,
        metrics={"class_scores": {"Safe Walkway Violation": 0.32}},
    )

    candidates = _build_violation_candidates(
        output, _video(), "VideoMAE", "/api/videos/7/stream", 45
    )

    assert len(candidates) == 1
    assert candidates[0]["confidence"] == 0.32


def test_classification_uses_frame_image_when_snapshot_write_fails(monkeypatch):
    monkeypatch.setattr(
        "app.services.inference_service._save_video_snapshot",
        lambda *_args: None,
    )
    output = InferenceOutput(
        type="classification",
        prediction="Safe Walkway Violation",
        confidence=0.8,
        metrics={"class_scores": {"Safe Walkway Violation": 0.8}},
    )

    candidates = _build_violation_candidates(
        output, _video(), "VideoMAE", "/api/videos/7/stream", 46
    )

    assert candidates[0]["snapshot_url"] == "/api/videos/7/thumbnail?frame_index=125"
    assert output.metrics["evidence_events"][0]["image"] == candidates[0]["snapshot_url"]


def test_ppe_violation_uses_exact_frame_when_crop_write_fails():
    output = InferenceOutput(
        type="detection",
        prediction="Suspected no helmet",
        confidence=0.91,
        metrics={"evidence_events": [{
            "class_name": "Suspected no helmet",
            "track_id": 12,
            "image": None,
            "frame_index": 50,
            "timestamp_seconds": 2.0,
            "person_confidence": 0.91,
        }]},
    )

    candidates = _build_violation_candidates(
        output, _video(), "RF-DETR", "/results/result.mp4", 47
    )

    assert len(candidates) == 1
    assert candidates[0]["title"] == "Nghi ngờ không đội mũ bảo hộ"
    assert candidates[0]["snapshot_url"] == "/api/videos/7/thumbnail?frame_index=50"
    assert output.metrics["evidence_events"][0]["image"] == candidates[0]["snapshot_url"]


def test_all_detected_people_become_candidates_without_twenty_alert_limit():
    output = InferenceOutput(
        type="detection",
        prediction="Suspected no helmet",
        confidence=0.9,
        metrics={"evidence_events": [
            {
                "class_name": "Suspected no helmet",
                "track_id": track_id,
                "image": f"/results/person-{track_id}.jpg",
                "frame_index": track_id,
                "person_confidence": 0.9,
            }
            for track_id in range(1, 31)
        ]},
    )

    candidates = _build_violation_candidates(
        output, _video(), "RF-DETR", "/results/result.mp4", 48
    )

    assert len(candidates) == 30
    assert len({item["deduplication_key"] for item in candidates}) == 30


def test_complete_inference_uses_cursor_for_batch_inserts(monkeypatch):
    conn = Mock(spec=["execute", "cursor", "commit"])
    cursor = MagicMock()
    conn.cursor.return_value.__enter__ = Mock(return_value=cursor)
    conn.cursor.return_value.__exit__ = Mock(return_value=False)

    @contextmanager
    def fake_connection():
        yield conn

    monkeypatch.setattr(database, "connection", fake_connection)
    database.complete_inference(
        42,
        1.5,
        "/results/video.mp4",
        {"evidence_events": []},
        [{"class_name": "Safe Walkway", "confidence": 0.9}],
        [{
            "class_name": "person", "confidence": 0.8,
            "x1": 1, "y1": 2, "x2": 3, "y2": 4,
            "frame_index": 5, "is_violation": False,
        }],
    )

    assert cursor.executemany.call_count == 2
    conn.commit.assert_called_once()

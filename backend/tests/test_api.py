from unittest.mock import patch

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.auth import camera_viewer, dashboard_viewer
from app.main import app


@pytest.fixture(autouse=True)
def authorized_api_user():
    app.dependency_overrides[camera_viewer] = lambda: {"id": "test-camera-user"}
    app.dependency_overrides[dashboard_viewer] = lambda: {"id": "test-dashboard-user"}
    yield
    app.dependency_overrides.pop(camera_viewer, None)
    app.dependency_overrides.pop(dashboard_viewer, None)


def offline_database():
    return patch("app.database.database.is_database_available", return_value=False)


def test_catalog_endpoints_return_real_repository_data():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            videos_response = client.get("/api/videos/test")
            models_response = client.get("/api/models")

    assert videos_response.status_code == 200
    videos = videos_response.json()
    assert len(videos) == 100
    assert videos[0]["split"] == "test"
    assert videos[0]["filename"].endswith(".mp4")

    assert models_response.status_code == 200
    models = models_response.json()
    assert [model["name"] for model in models] == ["RF-DETR", "VideoMAE"]


def test_models_outside_the_two_model_pipeline_are_rejected():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            response = client.post(
                "/api/inference",
                json={"video_id": 1, "model_name": "YOLO26x"},
            )

    assert response.status_code == 400
    body = response.json()
    assert "Unsupported model" in body["detail"]
    assert "prediction" not in body


def test_video_stream_uses_dataset_file():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            response = client.get("/api/videos/1/stream", headers={"Range": "bytes=0-1023"})

    assert response.status_code in {200, 206}
    assert response.headers["content-type"].startswith("video/mp4")
    assert len(response.content) > 0


def test_test_video_media_can_stream_without_bearer_token():
    app.dependency_overrides.pop(camera_viewer, None)
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            catalog_response = client.get("/api/videos/test")
            stream_response = client.get(
                "/api/videos/1/stream",
                headers={"Range": "bytes=0-1023"},
            )
            thumbnail_response = client.get("/api/videos/1/thumbnail")

    assert catalog_response.status_code == 401
    assert stream_response.status_code in {200, 206}
    assert stream_response.headers["content-type"].startswith("video/mp4")
    assert thumbnail_response.status_code == 200
    assert thumbnail_response.headers["content-type"].startswith("image/jpeg")


def test_video_thumbnail_is_extracted_from_dataset_video():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            response = client.get("/api/videos/1/thumbnail")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content.startswith(b"\xff\xd8")


def test_violation_evidence_thumbnail_uses_requested_full_resolution_frame():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            videos = client.get("/api/videos/test").json()
            response = client.get("/api/videos/1/thumbnail?frame_index=0")

    assert response.status_code == 200
    frame = cv2.imdecode(np.frombuffer(response.content, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert frame is not None
    assert frame.shape[1] == videos[0]["width"]
    assert frame.shape[0] == videos[0]["height"]

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


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


def test_video_thumbnail_is_extracted_from_dataset_video():
    with patch("app.database.database.initialize_database", side_effect=RuntimeError("test database offline")):
        with offline_database(), TestClient(app) as client:
            response = client.get("/api/videos/1/thumbnail")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content.startswith(b"\xff\xd8")

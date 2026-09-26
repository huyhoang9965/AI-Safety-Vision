from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.auth import dashboard_viewer
from app.api.models import model_manager
from app.main import app
from app.services import model_management_service
from app.services.model_management_service import ModelManagementNotFound


def management_payload():
    now = datetime.now(timezone.utc)
    camera_id = uuid4()
    return {
        "models": [
            {
                "code": "RF_DETR",
                "name": "RF-DETR",
                "version": "1.0",
                "type": "detection",
                "framework": "PyTorch / Transformers",
                "connected": True,
                "loaded": False,
                "status": "Checkpoint ready",
                "artifact_name": "best_total.pth",
                "artifact_size_bytes": 1024,
                "labels": ["person", "helmet"],
                "active_deployments": 0,
                "camera_coverage": 0,
                "stats": {
                    "total_runs": 0,
                    "completed_runs": 0,
                    "failed_runs": 0,
                    "average_processing_seconds": None,
                    "last_run_at": None,
                    "detections": 0,
                    "violations": 0,
                    "average_confidence": None,
                },
            }
        ],
        "deployments": [],
        "cameras": [
            {
                "id": camera_id,
                "code": "CAM-001",
                "name": "Cổng chính",
                "site_name": "Nhà máy",
                "zone_name": "Khu A",
                "status": "online",
            }
        ],
        "recent_inferences": [],
        "class_metrics": [],
        "daily_metrics": [],
        "summary": {
            "total_models": 1,
            "connected_models": 1,
            "loaded_models": 0,
            "active_deployments": 0,
            "cameras_covered": 0,
            "runs_24h": 0,
            "failures_24h": 0,
            "average_processing_seconds": None,
        },
    }


@pytest.fixture
def models_client():
    user = {
        "id": uuid4(),
        "memberships": [{"organization_id": uuid4(), "is_default": True}],
    }
    app.dependency_overrides[dashboard_viewer] = lambda: user
    app.dependency_overrides[model_manager] = lambda: user
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(model_manager, None)
    app.dependency_overrides.pop(dashboard_viewer, None)


def test_management_returns_registry_and_camera_options(models_client, monkeypatch):
    monkeypatch.setattr(
        model_management_service, "management_data", lambda _user: management_payload()
    )

    response = models_client.get("/api/models/management")

    assert response.status_code == 200
    assert response.json()["models"][0]["code"] == "RF_DETR"
    assert response.json()["cameras"][0]["code"] == "CAM-001"
    assert response.json()["summary"]["connected_models"] == 1


def test_deploy_calls_service_for_selected_cameras(models_client, monkeypatch):
    camera_id = uuid4()
    captured = {}

    def fake_deploy(model_code, body, _user):
        captured["model_code"] = model_code
        captured["camera_ids"] = body.camera_ids
        captured["threshold"] = body.confidence_threshold
        return len(body.camera_ids)

    monkeypatch.setattr(model_management_service, "deploy", fake_deploy)
    response = models_client.post(
        "/api/models/RF_DETR/deploy",
        json={"camera_ids": [str(camera_id)], "confidence_threshold": 0.65},
    )

    assert response.status_code == 200
    assert response.json()["affected"] == 1
    assert captured == {
        "model_code": "RF_DETR",
        "camera_ids": [camera_id],
        "threshold": 0.65,
    }


@pytest.mark.parametrize("threshold", [0.09, 1.0])
def test_threshold_validation_rejects_values_outside_safe_range(
    models_client, threshold
):
    response = models_client.post(
        f"/api/models/deployments/{uuid4()}/threshold",
        json={"confidence_threshold": threshold},
    )

    assert response.status_code == 422


def test_unknown_deployment_returns_not_found(models_client, monkeypatch):
    def missing(*_args):
        raise ModelManagementNotFound("Không tìm thấy bản triển khai")

    monkeypatch.setattr(model_management_service, "set_deployment_status", missing)
    response = models_client.post(
        f"/api/models/deployments/{uuid4()}/status",
        json={"is_enabled": False},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Không tìm thấy bản triển khai"

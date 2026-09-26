from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.auth import camera_viewer, require_permission
from app.model_schemas import (
    DeploymentStatusRequest,
    DeploymentThresholdRequest,
    ModelActionResponse,
    ModelDeployRequest,
    ModelManagementResponse,
)
from app.models.registry import registry
from app.schemas import ModelItem
from app.services import model_management_service
from app.services.model_management_service import (
    ModelManagementConflict,
    ModelManagementNotFound,
)

router = APIRouter(
    prefix="/api/models",
    tags=["models"],
)
model_manager = require_permission("camera.manage")


def _management_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ModelManagementNotFound):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, ModelManagementConflict):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Không thể cập nhật dữ liệu mô hình AI",
    )


@router.get(
    "",
    response_model=list[ModelItem],
    dependencies=[Depends(camera_viewer)],
)
def get_models() -> list[ModelItem]:
    response = []
    for spec in registry.specs():
        connected, status = spec.connection_status()
        response.append(
            ModelItem(
                name=spec.name,
                type=spec.type,
                version=spec.version,
                connected=connected,
                loaded=registry.is_loaded(spec.name),
                status=status,
                weight_path=str(spec.weight_path) if spec.weight_path else None,
            )
        )
    return response


@router.get("/management", response_model=ModelManagementResponse)
def management(
    user: Annotated[dict, Depends(model_manager)],
) -> ModelManagementResponse:
    try:
        return ModelManagementResponse(**model_management_service.management_data(user))
    except Exception as exc:
        raise _management_error(exc) from exc


@router.post("/{model_code}/deploy", response_model=ModelActionResponse)
def deploy(
    model_code: str,
    body: ModelDeployRequest,
    user: Annotated[dict, Depends(model_manager)],
) -> ModelActionResponse:
    try:
        affected = model_management_service.deploy(model_code, body, user)
        return ModelActionResponse(
            success=True,
            message=f"Đã triển khai mô hình lên {affected} camera",
            affected=affected,
        )
    except Exception as exc:
        raise _management_error(exc) from exc


@router.post(
    "/deployments/{deployment_id}/status",
    response_model=ModelActionResponse,
)
def deployment_status(
    deployment_id: UUID,
    body: DeploymentStatusRequest,
    user: Annotated[dict, Depends(model_manager)],
) -> ModelActionResponse:
    try:
        model_management_service.set_deployment_status(
            deployment_id, body.is_enabled, user
        )
        return ModelActionResponse(
            success=True,
            message="Đã cập nhật trạng thái triển khai",
            affected=1,
        )
    except Exception as exc:
        raise _management_error(exc) from exc


@router.post(
    "/deployments/{deployment_id}/threshold",
    response_model=ModelActionResponse,
)
def deployment_threshold(
    deployment_id: UUID,
    body: DeploymentThresholdRequest,
    user: Annotated[dict, Depends(model_manager)],
) -> ModelActionResponse:
    try:
        model_management_service.set_threshold(
            deployment_id, body.confidence_threshold, user
        )
        return ModelActionResponse(
            success=True,
            message="Đã cập nhật ngưỡng phát hiện",
            affected=1,
        )
    except Exception as exc:
        raise _management_error(exc) from exc

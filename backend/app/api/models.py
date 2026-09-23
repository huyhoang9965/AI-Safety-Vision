from __future__ import annotations

from fastapi import APIRouter

from app.models.registry import registry
from app.schemas import ModelItem

router = APIRouter(prefix="/api/models", tags=["models"])


@router.get("", response_model=list[ModelItem])
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

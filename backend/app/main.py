from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

from app.api.inference import router as inference_router
from app.api.models import router as models_router
from app.api.videos import router as videos_router
from app.config import get_settings
from app.database import database
from app.models.registry import registry
from app.services.manifest import load_test_manifest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    settings = get_settings()
    settings.ensure_storage()
    videos = load_test_manifest()
    logger.info("Loaded %d final_split=test videos from %s", len(videos), settings.manifest_path)

    try:
        database.initialize_database()
        database.sync_videos(videos)
        database.sync_models(registry.catalog_rows())
        logger.info("PostgreSQL schema and catalog are ready")
    except Exception as exc:
        logger.warning(
            "PostgreSQL is not ready; inference remains real but history will not be persisted: %s",
            exc,
        )
    yield


settings = get_settings()
settings.ensure_storage()

app = FastAPI(
    title="AI Safety Monitoring API",
    version="1.0.0",
    description="Real test-video inference API with lazy-loaded safety models.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.frontend_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/results", StaticFiles(directory=settings.output_dir), name="results")
app.include_router(videos_router)
app.include_router(models_router)
app.include_router(inference_router)


@app.get("/api/health", tags=["health"])
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "database": "connected" if database.is_database_available() else "unavailable",
        "test_videos": len(load_test_manifest()),
        "loaded_models": [spec.name for spec in registry.specs() if registry.is_loaded(spec.name)],
    }

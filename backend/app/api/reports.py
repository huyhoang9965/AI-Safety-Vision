from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response

from app.api.auth import require_permission
from app.report_schemas import ReportOverviewResponse
from app.services import report_service
from app.services.report_service import ReportConflictError


router = APIRouter(prefix="/api/reports", tags=["reports"])
report_viewer = require_permission("report.view")


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, ReportConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Không thể tổng hợp dữ liệu báo cáo",
    )


@router.get("/overview", response_model=ReportOverviewResponse)
def overview(
    user: Annotated[dict, Depends(report_viewer)],
    period: Literal["7d", "30d", "90d", "365d"] = "30d",
    site: str | None = Query(default=None, max_length=50),
) -> ReportOverviewResponse:
    try:
        days = int(period[:-1])
        return ReportOverviewResponse(**report_service.overview(user, days, site))
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/export")
def export(
    user: Annotated[dict, Depends(report_viewer)],
    period: Literal["7d", "30d", "90d", "365d"] = "30d",
    site: str | None = Query(default=None, max_length=50),
) -> Response:
    try:
        content = report_service.export_csv(user, int(period[:-1]), site)
    except Exception as exc:
        raise _error(exc) from exc
    filename = f"bao-cao-an-toan-{period}.csv"
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

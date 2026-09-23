from __future__ import annotations

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.schemas import VideoItem
from app.services.video_catalog import list_test_videos, resolve_video

router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.get("/test", response_model=list[VideoItem])
def get_test_videos() -> list[VideoItem]:
    return [
        VideoItem(
            id=video.id,
            filename=video.filename,
            path=str(video.filepath),
            labels=list(video.labels),
            duration=video.duration,
            width=video.width,
            height=video.height,
            fps=video.fps,
            stream_url=f"/api/videos/{video.id}/stream",
        )
        for video in list_test_videos()
    ]


@router.get("/{video_id}/stream")
def stream_test_video(video_id: int) -> FileResponse:
    video = resolve_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Test video not found")
    if not video.filepath.is_file():
        raise HTTPException(status_code=404, detail=f"Video file is missing: {video.filename}")
    return FileResponse(
        path=video.filepath,
        media_type="video/mp4",
        filename=video.filename,
        content_disposition_type="inline",
    )


@router.get("/{video_id}/thumbnail")
def get_video_thumbnail(video_id: int) -> Response:
    video = resolve_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Test video not found")
    if not video.filepath.is_file():
        raise HTTPException(status_code=404, detail=f"Video file is missing: {video.filename}")

    capture = cv2.VideoCapture(str(video.filepath))
    if not capture.isOpened():
        raise HTTPException(status_code=422, detail=f"Cannot read video: {video.filename}")
    try:
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(frame_count * 0.55)))
        ok, frame = capture.read()
    finally:
        capture.release()

    if not ok:
        raise HTTPException(status_code=422, detail=f"Cannot extract thumbnail: {video.filename}")

    height, width = frame.shape[:2]
    if width > 960:
        scale = 960 / width
        frame = cv2.resize(frame, (960, max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
    encoded, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 84])
    if not encoded:
        raise HTTPException(status_code=500, detail="Could not encode video thumbnail")
    return Response(
        content=buffer.tobytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )

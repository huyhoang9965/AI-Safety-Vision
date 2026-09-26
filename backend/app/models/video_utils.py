from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def sample_midpoint_indices(total_frames: int, num_frames: int) -> np.ndarray:
    if total_frames <= 0:
        raise ValueError("Video has no frames")
    if total_frames < num_frames:
        return np.linspace(0, total_frames - 1, num_frames).astype(np.int64)

    edges = np.linspace(0, total_frames, num_frames + 1)
    indices = []
    for index in range(num_frames):
        start = int(np.floor(edges[index]))
        end = max(start, int(np.floor(edges[index + 1])) - 1)
        indices.append(min((start + end) // 2, total_frames - 1))
    return np.asarray(indices, dtype=np.int64)


def read_sampled_rgb_frames(video_path: Path, num_frames: int) -> tuple[np.ndarray, np.ndarray]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Cannot open test video: {video_path}")

    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    indices = sample_midpoint_indices(total_frames, num_frames)
    try:
        collected = []
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"Missing sampled frame {int(index)} in {video_path.name}")
            collected.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    finally:
        capture.release()

    return np.stack(collected, axis=0), indices


def letterbox_mean_pad(frames: np.ndarray, image_size: int) -> np.ndarray:
    imagenet_mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
    pad_rgb = np.round(imagenet_mean * 255).astype(np.uint8)
    output = []

    for frame in frames:
        height, width = frame.shape[:2]
        scale = min(image_size / width, image_size / height)
        new_width = int(round(width * scale))
        new_height = int(round(height * scale))
        resized = cv2.resize(frame, (new_width, new_height), interpolation=cv2.INTER_AREA)
        canvas = np.empty((image_size, image_size, 3), dtype=np.uint8)
        canvas[:] = pad_rgb
        x1 = (image_size - new_width) // 2
        y1 = (image_size - new_height) // 2
        canvas[y1 : y1 + new_height, x1 : x1 + new_width] = resized
        output.append(canvas)
    return np.stack(output, axis=0)


def normalize_imagenet(frames: np.ndarray):
    import torch

    tensor = torch.from_numpy(frames).to(dtype=torch.float32).permute(0, 3, 1, 2) / 255.0
    mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32).view(1, 3, 1, 1)
    return (tensor - mean) / std

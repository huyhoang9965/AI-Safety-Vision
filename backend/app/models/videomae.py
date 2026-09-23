from __future__ import annotations

import gc
from pathlib import Path

from app.config import get_settings
from app.models.base import InferenceOutput, ModelNotConnectedError
from app.models.video_utils import letterbox_mean_pad, normalize_imagenet, read_sampled_rgb_frames


class VideoMAEClassifier:
    def __init__(self, weight_path: Path):
        self.weight_path = weight_path
        self._model = None
        self._class_names: list[str] = []
        self._num_frames = 16
        self._image_size = 224
        self._device = "cpu"

    def _load(self):
        if self._model is not None:
            return self._model
        if not self.weight_path.is_file():
            raise ModelNotConnectedError(f"Checkpoint not found: {self.weight_path}")

        try:
            import torch
            from transformers import VideoMAEConfig, VideoMAEForVideoClassification
        except ImportError as exc:
            raise ModelNotConnectedError("torch and transformers are required for VideoMAE") from exc

        checkpoint = torch.load(self.weight_path, map_location="cpu", weights_only=False, mmap=True)
        state_dict = checkpoint.get("model_state_dict")
        self._class_names = list(checkpoint.get("class_names", []))
        self._num_frames = int(checkpoint.get("num_frames", 16))
        self._image_size = int(checkpoint.get("image_size", 224))
        if not state_dict or len(self._class_names) != 8:
            raise ModelNotConnectedError("VideoMAE checkpoint metadata is incomplete")

        config = VideoMAEConfig(
            image_size=self._image_size,
            num_frames=self._num_frames,
            num_labels=len(self._class_names),
            id2label={index: label for index, label in enumerate(self._class_names)},
            label2id={label: index for index, label in enumerate(self._class_names)},
            problem_type="multi_label_classification",
        )
        model = VideoMAEForVideoClassification(config)
        try:
            model.load_state_dict(state_dict, strict=True)
        except RuntimeError as exc:
            raise ModelNotConnectedError(f"VideoMAE checkpoint architecture mismatch: {exc}") from exc

        configured_device = get_settings().device
        self._device = (
            configured_device
            if configured_device != "auto"
            else ("cuda" if torch.cuda.is_available() else "cpu")
        )
        model.to(self._device)
        model.eval()
        self._model = model
        del checkpoint, state_dict
        gc.collect()
        return self._model

    def infer(self, video_path: Path, output_dir: Path) -> InferenceOutput:
        del output_dir
        import torch

        model = self._load()
        frames, indices = read_sampled_rgb_frames(video_path, self._num_frames)
        frames = letterbox_mean_pad(frames, self._image_size)
        pixel_values = normalize_imagenet(frames).unsqueeze(0).to(self._device)

        with torch.inference_mode():
            logits = model(pixel_values=pixel_values).logits
            probabilities = torch.sigmoid(logits)[0].detach().cpu().tolist()

        scores = {
            class_name: float(probability)
            for class_name, probability in zip(self._class_names, probabilities)
        }
        top_class = max(scores, key=scores.get)
        prediction_rows = [
            {"class_name": class_name, "confidence": confidence}
            for class_name, confidence in scores.items()
        ]
        return InferenceOutput(
            type="classification",
            prediction=top_class,
            confidence=scores[top_class],
            metrics={
                "class_scores": scores,
                "predicted_classes": [name for name, score in scores.items() if score >= 0.5],
                "sampled_frames": indices.tolist(),
                "num_frames": self._num_frames,
            },
            predictions=prediction_rows,
        )

"""Audit repository test clips with the production VideoMAE adapter, without DB writes."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from dotenv import load_dotenv
load_dotenv(BACKEND_ROOT / ".env")

from app.models.registry import registry
from app.services.manifest import load_test_manifest

UNSAFE = {"Safe Walkway Violation", "Unauthorized Intervention", "Opened Panel Cover", "Carrying Overload with Forklift"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=BACKEND_ROOT.parent / "storage/outputs/demo-video-review/audit.json")
    parser.add_argument("--filenames", nargs="*")
    args = parser.parse_args()
    spec, adapter = registry.get_adapter("VideoMAE")
    videos = [video for video in load_test_manifest() if not args.filenames or video.filename in args.filenames]
    if args.filenames and len(videos) != len(set(args.filenames)):
        raise SystemExit("Every requested filename must belong to final_split=test.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with spec.weight_path.open("rb") as checkpoint:
        checkpoint_sha256 = hashlib.file_digest(checkpoint, "sha256").hexdigest()
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "model": spec.name,
              "checkpoint": str(spec.weight_path.relative_to(BACKEND_ROOT.parent)),
              "checkpoint_sha256": checkpoint_sha256,
              "split": "test", "min_confidence": .90, "min_margin": .20, "videos": []}
    started = perf_counter()
    for index, video in enumerate(videos, start=1):
        item = {"filename": video.filename, "labels": list(video.labels), "duration": video.duration}
        try:
            result = adapter.infer(video.filepath, args.output.parent)
            ranked = sorted(result.metrics["class_scores"].items(), key=lambda pair: pair[1], reverse=True)
            margin = ranked[0][1] - ranked[1][1]
            item.update(prediction=result.prediction, confidence=result.confidence, margin=margin,
                        class_scores=result.metrics["class_scores"], sampled_frames=result.metrics["sampled_frames"],
                        matches_label=result.prediction in video.labels,
                        eligible=result.prediction in UNSAFE and result.prediction in video.labels
                        and result.confidence >= .90 and margin >= .20)
        except Exception as error:
            item["error"] = str(error)
        report["videos"].append(item)
        report["elapsed_seconds"] = round(perf_counter() - started, 2)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{index}/{len(videos)}] {video.filename}: {item.get('prediction', 'ERROR')} "
              f"{item.get('confidence', 0):.3f}, margin={item.get('margin', 0):.3f}", flush=True)
    print(f"Audit saved: {args.output}; eligible={sum(v.get('eligible', False) for v in report['videos'])}")


if __name__ == "__main__":
    main()

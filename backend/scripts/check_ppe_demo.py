"""Run real PPE checkpoints on curated clips without writing database alerts."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from dotenv import load_dotenv
load_dotenv(ROOT / 'backend/.env')
os.environ['AI_PRELOAD_MODELS'] = 'false'
from app.config import get_settings
from app.models.registry import registry
from app.services.manifest import load_test_manifest
from app.services.inference_service import detection_overlay_frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--filenames', nargs='+', default=['2_te3.mp4', '2_tr14.mp4', '2_tr91.mp4', '1_tr25.mp4', '1_te9.mp4'])
    args = parser.parse_args()
    videos = {video.filename: video for video in load_test_manifest()}
    presets = json.loads((ROOT / 'web/lib/demo-camera-presets.json').read_text(encoding='utf-8'))
    _, adapter = registry.get_adapter('RF-DETR')
    out = get_settings().output_dir / 'ppe-panel-review'
    out.mkdir(parents=True, exist_ok=True)
    records = []
    for name in args.filenames:
        if name not in videos or not any(name in p['filenames'] for p in presets):
            parser.error(f'Not a curated test clip: {name}')
        started = perf_counter()
        result = adapter.infer(videos[name].filepath, out)
        result.metrics['overlay_frames'] = detection_overlay_frames(result, videos[name].duration)
        events = result.metrics.get('evidence_events', [])
        row = dict(filename=name, elapsed_seconds=round(perf_counter()-started, 2), duration_seconds=videos[name].duration,
                   output_video=str(result.output_path), metrics=result.metrics,
                   detections=result.detections, evidence_events=events)
        records.append(row)
        (out / 'ppe-audit.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'{name}: {result.metrics["inference_frames"]} frames, {result.metrics["inference_fps"]} fps; '
              f'{len(events)} events: ' + ', '.join(f'{e["class_name"]} #{e["track_id"]}' for e in events), flush=True)
    print('Report: storage/outputs/ppe-panel-review/ppe-audit.json', flush=True)


if __name__ == '__main__':
    main()

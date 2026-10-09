"""Check actual classification + localization without creating database alerts."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
from dotenv import load_dotenv
load_dotenv(ROOT/'backend/.env')
os.environ['AI_PRELOAD_MODELS']='false'

from app.config import get_settings
from app.models.registry import registry
from app.services.behavior_verification import verify_behavior, PIPELINE_VERSION
from app.services.manifest import load_test_manifest


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--filenames',nargs='+',default=['3_tr39.mp4','3_te1.mp4','7_tr19.mp4','0_tr79.mp4'])
    args=parser.parse_args()
    presets=json.loads((ROOT/'web/lib/demo-camera-presets.json').read_text(encoding='utf-8'))
    videos={video.filename:video for video in load_test_manifest()}
    _,adapter=registry.get_adapter('VideoMAE')
    rows=[]
    report_path=get_settings().output_dir/'demo-video-review/behavior-verification.json'
    report_path.parent.mkdir(parents=True,exist_ok=True)
    for name in args.filenames:
        preset=next((preset for preset in presets if name in preset['filenames']),None)
        if not preset or name not in videos:parser.error(f'Not a curated demo test clip: {name}')
        started=perf_counter()
        result=adapter.infer(videos[name].filepath,get_settings().output_dir)
        verify_behavior(result,videos[name].filepath,preset['key'])
        metrics=result.metrics
        events=metrics['evidence_events']
        rows.append(dict(filename=name,camera=preset['key'],prediction=result.prediction,confidence=result.confidence,
            duration_seconds=videos[name].duration,verification=metrics['verification'],
            elapsed_seconds=round(perf_counter()-started,3),event_count=len(events),
            overlay_frames=metrics['overlay_frames'],evidence_events=events))
        report_path.write_text(json.dumps(dict(pipeline_version=PIPELINE_VERSION,
            generated_at=datetime.now(timezone.utc).isoformat(),videos=rows),ensure_ascii=False,indent=2),encoding='utf-8')
        print(f'{name}: {metrics["verification"]}; {len(events)} event(s), {len(metrics["overlay_frames"])} object frames',flush=True)
    print(f'Report: {report_path.relative_to(ROOT)}',flush=True)


if __name__ == '__main__':main()

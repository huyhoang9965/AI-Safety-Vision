import json
import csv
from pathlib import Path

from app.services.manifest import load_test_manifest


def test_demo_uses_thirteen_unique_existing_test_clips_with_supported_unsafe_labels():
    presets = json.loads((Path(__file__).resolve().parents[2] / "web/lib/demo-camera-presets.json").read_text(encoding="utf-8"))
    filenames = [filename for preset in presets for filename in preset["filenames"]]
    assert len(filenames) == 13
    assert len(set(filenames)) == 13
    videos = {video.filename: video for video in load_test_manifest()}
    expected = {"CAM-01": "Safe Walkway Violation", "CAM-02": "Carrying Overload with Forklift",
                "CAM-03": "Opened Panel Cover", "CAM-04": "Unauthorized Intervention", "CAM-05": "Safe Walkway Violation"}
    for preset in presets:
        for filename in preset["filenames"]:
            assert filename in videos
            assert videos[filename].filepath.is_file()
            assert ("Safe Carrying" if filename == "7_tr19.mp4" else expected[preset["key"]]) in videos[filename].labels
    assert not {"3_tr11.mp4", "3_tr14.mp4", "2_tr123.mp4", "2_te12.mp4", "1_tr24.mp4", "1_tr27.mp4", "1_tr60.mp4"}.intersection(filenames)
    camera = next(p for p in presets if p["key"] == "CAM-02")
    manifest_path = Path(__file__).resolve().parents[2]/"outputs/video_audit/video_manifest_FINAL_kaggle.csv"
    rows = list(csv.DictReader(manifest_path.open(encoding="utf-8-sig")))
    groups = {row["canonical_filename"]:row["source_group"] for row in rows}
    assert len({groups[name] for name in camera["filenames"]}) == len(camera["filenames"])

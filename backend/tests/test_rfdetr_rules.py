from pathlib import Path
from unittest.mock import Mock
import numpy as np
from app.models.rfdetr import RFDETRDetector
from app.models.detection_common import FrameDetection, render_detection_video
from app.models.person_locator import inference_windows, tile_windows
import cv2


def detector_for(people, ppe=None):
    detector = RFDETRDetector(Path("unused.pth"))
    detector._people = Mock()
    detector._people.predict.return_value = people
    detector._person_ppe = Mock(return_value=ppe or [])
    return detector


def test_two_stationary_occluded_people_have_separate_head_alerts():
    people = [FrameDetection("Person", .8, 410,395,461,529),
              FrameDetection("Person", .8, 538,465,590,524)]
    detector = detector_for(people)
    frame = np.zeros((1080,1920,3),dtype=np.uint8)
    assert not any(item.is_violation for item in detector._predict_frame(frame))
    result = detector._predict_frame(frame)
    missing = [item for item in result if item.class_name == "Suspected no helmet"]
    assert len(missing) == 2
    assert len({item.track_id for item in missing}) == 2
    for head in missing:
        person = next(p for p in result if p.class_name == "Person" and p.track_id == head.track_id)
        assert person.x1 <= head.x1 < head.x2 <= person.x2
        assert person.y1 <= head.y1 < head.y2 <= person.y2
    # Do not infer vest absence for a person whose torso is hidden.
    partial_id = next(p.track_id for p in result if p.class_name == "Person" and p.x1 == 538)
    assert not any(p.class_name == "Suspected no vest" and p.track_id == partial_id for p in result)


def test_motion_or_hanging_vest_without_person_cannot_create_violation():
    detector = detector_for([])
    frame = np.zeros((480,640,3),dtype=np.uint8)
    detector._predict_frame(frame)
    frame[100:450,100:200] = 255
    assert detector._predict_frame(frame) == []
    detector._person_ppe.assert_not_called()


def test_helmet_on_another_person_does_not_suppress_missing_helmet():
    people = [FrameDetection("Person",.9,100,100,160,300),FrameDetection("Person",.9,300,100,360,300)]
    helmet = FrameDetection("helmet",.9,110,100,150,135)
    detector = detector_for(people,[helmet])
    frame = np.zeros((480,640,3),dtype=np.uint8)
    detector._predict_frame(frame)
    alerts = [d for d in detector._predict_frame(frame) if d.class_name == "Suspected no helmet"]
    assert len(alerts) == 1
    assert alerts[0].x1 >= 300


def test_reappearing_person_requires_fresh_confirmation():
    person = FrameDetection("Person",.9,100,100,160,300)
    detector = detector_for([person])
    frame = np.zeros((480,640,3),dtype=np.uint8)
    detector._predict_frame(frame)
    detector._people.predict.return_value = []
    detector._predict_frame(frame)
    detector._people.predict.return_value = [person]
    assert not any(d.is_violation for d in detector._predict_frame(frame))


def test_tiles_cover_far_edges():
    windows = tile_windows(1920,1080)
    assert (0,0,960,720) in windows
    assert any(x2 == 1920 and y2 == 1080 for _,_,x2,y2 in windows)
    assert tile_windows(640,480) == [(0,0,640,480)]


def test_fast_locator_uses_one_full_frame_pass():
    assert inference_windows(1920, 1080, use_tiles=False) == [(0, 0, 1920, 1080)]
    tiled = inference_windows(1920, 1080, use_tiles=True)
    assert tiled[0] == (0, 0, 1920, 1080)
    assert len(tiled) > 1


def test_evidence_keeps_two_people_with_same_violation(tmp_path):
    source = tmp_path/"source.mp4"
    writer = cv2.VideoWriter(str(source),cv2.VideoWriter_fourcc(*"mp4v"),5,(320,240))
    for _ in range(3):
        writer.write(np.zeros((240,320,3),dtype=np.uint8))
    writer.release()
    boxes = [FrameDetection("Suspected no helmet",.8,40,40,70,70,True,1),
             FrameDetection("Suspected no helmet",.7,200,40,230,70,True,2)]
    output = render_detection_video(source,tmp_path/"out","test",lambda _: boxes)
    events = output.metrics["evidence_events"]
    assert len(events) == 2
    assert {e["track_id"] for e in events} == {1,2}
    assert events[0]["image"] != events[1]["image"]
    for event in events:
        crop = cv2.imread(str(tmp_path/"out"/Path(event["image"]).name))
        assert crop is not None
        assert crop.shape[1] < 320
        assert event["confidence"] is None

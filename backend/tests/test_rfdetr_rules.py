from pathlib import Path
from unittest.mock import Mock
import numpy as np
from app.models.rfdetr import RFDETRDetector
from app.models.detection_common import FrameDetection, render_detection_video
from app.models.person_locator import PersonLocator, inference_windows, tile_windows, calibrated_windows, merge_people
from types import SimpleNamespace
from app.models.visible_person_tracking import head_features, continue_visible_person
import cv2
import pytest


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


def test_recently_detected_vest_suppresses_dropouts_on_its_person_only():
    people = [FrameDetection('Person',.9,100,100,160,300), FrameDetection('Person',.9,300,100,360,300)]
    vest = FrameDetection('Vest',.85,108,145,152,210)
    detector = detector_for(people,[vest])
    frame = np.zeros((480,640,3),dtype=np.uint8)
    detector._predict_frame(frame)
    detector._person_ppe.return_value = []
    for _ in range(detector._vest_grace_steps):
        result = detector._predict_frame(frame)
        assert not any(d.class_name == 'Suspected no vest' and d.track_id == 1 for d in result)
        assert not any(d.class_name == 'Vest' for d in result)  # Do not draw a stale box.
    assert any(d.class_name == 'Suspected no vest' and d.track_id == 2 for d in result)
    assert any(d.class_name == 'Suspected no helmet' and d.track_id == 1 for d in result)
    # If the vest stays absent past the grace period, fresh observations alert.
    assert not any(d.class_name == 'Suspected no vest' and d.track_id == 1 for d in detector._predict_frame(frame))
    assert any(d.class_name == 'Suspected no vest' and d.track_id == 1 for d in detector._predict_frame(frame))


def test_neighbor_vest_never_creates_positive_memory_and_long_gap_expires_it():
    person = FrameDetection('Person',.9,100,100,160,300)
    detector = detector_for([person],[FrameDetection('Vest',.95,300,150,360,210)])
    frame = np.zeros((480,640,3),dtype=np.uint8)
    detector._predict_frame(frame)
    assert any(d.class_name == 'Suspected no vest' for d in detector._predict_frame(frame))
    detector._person_ppe.return_value = [FrameDetection('Vest',.85,108,145,152,210)]
    detector._predict_frame(frame)
    detector._people.predict.return_value = []
    for _ in range(detector._track_ttl+1):
        assert detector._predict_frame(frame) == []
    detector._people.predict.return_value = [person]
    detector._person_ppe.return_value = []
    assert not any(d.is_violation for d in detector._predict_frame(frame))
    assert any(d.class_name == 'Suspected no vest' for d in detector._predict_frame(frame))


def test_occluded_stationary_worker_keeps_identity_without_stale_boxes():
    person = FrameDetection('Person',.9,100,100,160,300)
    detector = detector_for([person]);detector._track_ttl=8
    frame = np.zeros((480,640,3),dtype=np.uint8)
    first=detector._predict_frame(frame)[0].track_id
    detector._predict_frame(frame)
    detector._people.predict.return_value=[]
    for _ in range(5):
        assert detector._predict_frame(frame)==[]
    detector._people.predict.return_value=[person]
    returning=detector._predict_frame(frame)
    assert returning[0].track_id==first
    assert not any(row.is_violation for row in returning)
    assert any(row.is_violation and row.track_id==first for row in detector._predict_frame(frame))


def test_full_body_to_visible_head_does_not_create_a_second_person_event():
    person=FrameDetection('Person',.9,100,100,160,300)
    detector=detector_for([person]);frame=np.zeros((480,640,3),dtype=np.uint8)
    first=detector._predict_frame(frame)[0].track_id
    detector._people.predict.return_value=[FrameDetection('Person',.9,110,101,150,150)]
    result=detector._predict_frame(frame)
    assert result[0].track_id==first
    assert any(row.class_name=='Suspected no helmet' and row.track_id==first for row in result)
    assert not any(row.class_name=='Suspected no vest' for row in result)


def test_moving_person_uses_recent_velocity_instead_of_starting_another_track():
    detector=detector_for([FrameDetection('Person',.9,100,100,160,300)])
    frame=np.zeros((480,640,3),dtype=np.uint8)
    identity=detector._predict_frame(frame)[0].track_id
    for x in [135,175,220]:
        detector._people.predict.return_value=[FrameDetection('Person',.9,x,100,x+60,300)]
        assert detector._predict_frame(frame)[0].track_id==identity


def test_tiles_cover_far_edges():
    windows = tile_windows(1920,1080)
    assert (0,0,960,720) in windows
    assert any(x2 == 1920 and y2 == 1080 for _,_,x2,y2 in windows)
    assert tile_windows(640,480) == [(0,0,640,480)]


def test_full_body_requires_same_person_in_context_and_not_a_neighbor():
    locator=PersonLocator(Path('unused.pt'))
    model=Mock()
    locator._model=model
    frame=np.zeros((480,640,3),np.uint8)
    person=FrameDetection('Person',.5,100,100,150,300)
    model.predict.return_value=[SimpleNamespace(boxes=[])]
    assert not locator._confirm_body(frame,person)
    # Crop starts at (50,30). A detection elsewhere in the crop is not enough.
    box=SimpleNamespace(xyxy=[np.array([170,70,220,270])],conf=np.array(.8))
    model.predict.return_value=[SimpleNamespace(boxes=[box])]
    assert not locator._confirm_body(frame,person)
    box.xyxy=[np.array([50,70,100,270])]
    assert locator._confirm_body(frame,person)
    model.predict.reset_mock()
    assert locator._confirm_body(frame,FrameDetection('Person',.5,100,100,150,155))
    model.predict.assert_not_called() # A head behind a machine needs surrounding context.


def test_focus_scale_can_recover_visible_body_without_creating_people_in_empty_views(monkeypatch):
    from app.models import person_locator as module
    monkeypatch.setattr(module,'get_settings',lambda:SimpleNamespace(person_locator_input_size=960,person_locator_tiling=False))
    locator=PersonLocator(Path('unused.pt'))
    model=Mock();locator._model=model
    def predict(frame,**kwargs):
        if frame.shape[:2] == (611,720) and kwargs['imgsz'] == 640:
            box=SimpleNamespace(xyxy=[np.array([220,200,280,340])],conf=np.array(.6))
            return [SimpleNamespace(boxes=[box])]
        return [SimpleNamespace(boxes=[])]
    model.predict.side_effect=predict
    frame=np.zeros((1080,1920,3),np.uint8)
    assert locator.predict(frame) == []
    people=locator.predict(frame,focus_windows=[[.095,.18,.47,.745]],focus_input_size=640)
    assert len(people)==1 and people[0].x1==402 and people[0].y1==394
    assert people[0].y2-people[0].y1==140 # The currently detected body, not an extrapolated torso.
    model.predict.side_effect=lambda *_args,**_kwargs:[SimpleNamespace(boxes=[])]
    assert locator.predict(frame,focus_windows=[[.095,.18,.47,.745]],focus_input_size=640)==[]
    with pytest.raises(ValueError):locator.predict(frame,focus_input_size=641)


def test_wider_context_confirms_same_occluded_body_and_rejects_neighbor():
    locator=PersonLocator(Path('unused.pt'));model=Mock();locator._model=model
    frame=np.zeros((480,640,3),np.uint8)
    person=FrameDetection('Person',.6,100,100,150,300)
    recovered=SimpleNamespace(xyxy=[np.array([100,100,150,300])],conf=np.array(.6))
    model.predict.side_effect=[[SimpleNamespace(boxes=[])],[SimpleNamespace(boxes=[recovered])]]
    assert locator._confirm_body(frame,person,[800,450])
    recovered.xyxy=[np.array([300,100,350,300])]
    model.predict.side_effect=[[SimpleNamespace(boxes=[])],[SimpleNamespace(boxes=[recovered])]]
    assert not locator._confirm_body(frame,person,[800,450])
    recovered.xyxy=[np.array([100,200,150,400])]
    model.predict.side_effect=[[SimpleNamespace(boxes=[])],[SimpleNamespace(boxes=[recovered])]]
    assert not locator._confirm_body(frame,person,[800,450]) # Different head, despite body overlap.


def test_recent_body_verification_requires_current_person_and_expires(monkeypatch):
    from app.models import person_locator as module
    monkeypatch.setattr(module,'get_settings',lambda:SimpleNamespace(person_locator_input_size=960,person_locator_tiling=False,rf_detr_inference_fps=2))
    locator=PersonLocator(Path('unused.pt'));model=Mock();locator._model=model
    box=SimpleNamespace(xyxy=[np.array([100,100,150,300])],conf=np.array(.6))
    model.predict.return_value=[SimpleNamespace(boxes=[box])]
    locator._confirm_body=Mock(side_effect=[True,False,False,False,False])
    frame=np.zeros((480,640,3),np.uint8)
    args=dict(confirm_bodies=True,body_context_size=[800,450])
    assert len(locator.predict(frame,**args))==1
    assert len(locator.predict(frame,**args))==1
    model.predict.return_value=[SimpleNamespace(boxes=[])]
    assert locator.predict(frame,**args)==[] # No old box in an empty frame.
    model.predict.return_value=[SimpleNamespace(boxes=[box])]
    assert len(locator.predict(frame,**args))==1
    assert locator.predict(frame,**args)==[] # Three steps after strict confirmation, grace ends.
    locator.reset_body_confirmations()
    assert locator.predict(frame,**args)==[]


def test_fast_locator_uses_one_full_frame_pass():
    assert inference_windows(1920, 1080, use_tiles=False) == [(0, 0, 1920, 1080)]
    tiled = inference_windows(1920, 1080, use_tiles=True)
    assert tiled[0] == (0, 0, 1920, 1080)
    assert len(tiled) > 1


def test_focus_windows_are_validated_and_partial_duplicates_keep_separate_workers():
    assert calibrated_windows(1920,1080,[[.1,.2,.4,.7],[.9,.2,.1,.7]]) == [(192,216,768,756)]
    whole=FrameDetection('Person',.7,400,390,460,530)
    head=FrameDetection('Person',.8,410,393,450,451)
    other=FrameDetection('Person',.65,532,460,590,524)
    assert merge_people([head,other,whole]) == [whole,other]


def test_visible_tracking_requires_real_texture_and_rejects_a_disappeared_head():
    person=FrameDetection('Person',.8,100,100,160,300)
    previous=np.zeros((480,640),dtype=np.uint8)
    previous[100:140,100:160]=np.random.default_rng(5).integers(40,240,(40,60),dtype=np.uint8)
    points=head_features(previous,person)
    moved=cv2.warpAffine(previous,np.float32([[1,0,2],[0,1,1]]),(640,480))
    result=continue_visible_person(previous,moved,person,points)
    assert result is not None
    assert abs(result[0].x1-102)<.3 and abs(result[0].y1-101)<.3
    assert continue_visible_person(previous,np.zeros_like(previous),person,points) is None
    assert continue_visible_person(previous,moved,person,None) is None


def test_visual_track_expires_and_cannot_create_people_from_an_empty_scene():
    person=FrameDetection('Person',.8,100,100,160,300)
    detector=detector_for([person]);detector._visual_tracking_steps=2
    frame=np.zeros((480,640,3),dtype=np.uint8)
    texture=np.random.default_rng(5).integers(40,240,(40,60),dtype=np.uint8)
    frame[100:140,100:160]=texture[:,:,None]
    detector._predict_frame(frame)
    detector._people.predict.return_value=[]
    for _ in range(2):
        result=detector._predict_frame(frame)
        assert any(d.class_name=='Person' and d.evidence_basis=='detector_anchored_visual_track' for d in result)
        assert any(d.class_name=='Suspected no helmet' for d in result)
    assert detector._predict_frame(frame)==[]
    detector._reset_tracks();detector._visual_tracking_steps=2
    assert detector._predict_frame(frame)==[]


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

from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import time
import pytest

import cv2
import numpy as np

from app.models.base import InferenceOutput
from app.services import behavior_verification as verification
from app.services import inference_service as service
from app.services.video_catalog import ResolvedVideo


def test_walkway_uses_feet_tolerates_border_and_ignores_outside_monitored_floor():
    lane=np.array([[[700,200]],[[900,200]],[[900,950]],[[700,950]]],np.int32)
    floor=[[.4,.2],[.95,.2],[.95,1],[.4,1]]
    assert not verification.outside_walkway([680,350,800,600],(1000,1000),floor,lane)
    assert not verification.outside_walkway([640,350,750,600],(1000,1000),floor,lane) # Border uncertainty.
    assert verification.outside_walkway([500,350,600,600],(1000,1000),floor,lane)
    assert not verification.outside_walkway([100,350,200,600],(1000,1000),floor,lane)
    assert not verification.outside_walkway([500,700,600,1000],(1000,1000),floor,lane) # Feet cut off.
    assert not verification.outside_walkway([500,350,600,600],(1000,1000),floor,None)


def test_overlapping_duplicates_merge_but_separate_people_and_error_types_remain():
    original=dict(class_name="Suspected no helmet",track_id=1,bbox=[100,100,200,300],timestamp_seconds=1)
    duplicate={**original,"track_id":2,"bbox":[102,102,202,302]}
    other_person={**original,"track_id":3,"bbox":[400,100,500,300]}
    other_error={**original,"class_name":"Suspected no vest"}
    events=verification.deduplicate_evidence([original,duplicate,other_person,other_error,{**original,"timestamp_seconds":8}])
    assert events == [original,other_person,other_error]


def test_classifier_alone_or_competing_safe_score_cannot_trigger_walkway_event():
    result=InferenceOutput(type="classification",prediction="Safe Walkway Violation",confidence=.98,metrics={"class_scores":{"Safe Walkway Violation":.98,"Safe Walkway":.9}})
    verification.verify_behavior(result,Path("not-a-video.mp4"),"CAM-01")
    assert result.metrics["verification"] == "uncertain_classification"
    assert result.metrics["evidence_events"] == []
    result.metrics["class_scores"]={"Safe Walkway Violation":.98}
    verification.verify_behavior(result,Path("uncalibrated.mp4"),"CAM-01")
    assert result.metrics["verification"] == "missing_walkway_calibration"


@pytest.mark.parametrize('moving,inside,expected',[(False,False,False),(True,True,False),(True,False,True)])
def test_walkway_requires_sustained_movement_outside_lane(monkeypatch,moving,inside,expected):
    class Capture:
        count=0
        def isOpened(self):return True
        def get(self, key):return {cv2.CAP_PROP_FPS:4,cv2.CAP_PROP_FRAME_WIDTH:1000,cv2.CAP_PROP_FRAME_HEIGHT:1000}.get(key,0)
        def read(self):
            self.count+=1
            return (True,np.zeros((1000,1000,3),np.uint8)) if self.count<=8 else (False,None)
        def release(self):pass
    calls=[]
    def predict(*_args,**_kwargs):
        offset=len(calls)*10 if moving else 0
        calls.append(1)
        x1=710 if inside else 500
        box=SimpleNamespace(xyxy=[np.array([x1+offset,350,x1+100+offset,600])])
        return [SimpleNamespace(boxes=[box])]
    model=SimpleNamespace(predict=predict)
    locator=SimpleNamespace(_load=lambda:model,_device="cpu")
    zone={"monitored_floor":[[.4,.2],[.95,.2],[.95,1],[.4,1]],"lane_search":[[.7,.2],[.9,.2],[.9,1],[.7,1]]}
    monkeypatch.setattr(verification,"_presets",lambda:[dict(key="CAM-01",filenames=["test.mp4"],walkway=zone)])
    monkeypatch.setattr(verification,"_locator",lambda:locator)
    monkeypatch.setattr(verification.cv2,"VideoCapture",lambda _:Capture())
    monkeypatch.setattr(verification,"green_walkway",lambda *_:np.array([[[700,200]],[[900,200]],[[900,950]],[[700,950]]],np.int32))
    output=InferenceOutput(type="classification",prediction="Safe Walkway Violation",confidence=.98)
    verification.verify_behavior(output,Path("test.mp4"),"CAM-01")
    assert bool(output.metrics["evidence_events"]) is expected
    assert bool(output.metrics["overlay_frames"]) is expected
    if expected:
        assert len(output.metrics['evidence_events']) == 1


def test_parallel_requests_and_page_reloads_reuse_same_analysis(monkeypatch,tmp_path):
    source=tmp_path/'test.mp4';source.write_bytes(b'test-video')
    video=ResolvedVideo(1,source.name,source,(),5,1920,1080,25)
    spec=SimpleNamespace(name="VideoMAE",weight_path=None)
    monkeypatch.setattr(service.registry,"get_spec",lambda _:spec)
    service._result_cache.clear()
    calls=[]
    @contextmanager
    def empty_cache(*_args):yield None
    monkeypatch.setattr(service,"_durable_cache_lock",empty_cache)
    result=service.InferenceServiceResult(1,"VideoMAE","classification","Safe Walkway",.9,"/api/videos/1/stream",1,{},True)
    def run(*_args):
        calls.append(1);time.sleep(.05);return result
    monkeypatch.setattr(service,"_run_inference_uncached",run)
    with ThreadPoolExecutor(max_workers=4) as executor:
        rows=list(executor.map(lambda _:service.run_inference(video,"VideoMAE","CAM-01"),range(4)))
    assert calls == [1]
    assert all(row.inference_id == result.inference_id for row in rows)
    assert service.run_inference(video,"VideoMAE","CAM-01").reused is True
    service._result_cache.clear()
    @contextmanager
    def completed_cache(*_args):yield result
    monkeypatch.setattr(service,"_durable_cache_lock",completed_cache)
    assert service.run_inference(video,"VideoMAE","CAM-01") is result
    assert calls == [1]
    service._result_cache.clear()

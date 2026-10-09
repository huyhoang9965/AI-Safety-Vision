from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np

from app.models.base import InferenceOutput
from app.models.detection_styles import detection_color
from app.services import behavior_verification as behavior, panel_localization as panels
from app.services.inference_service import _classification_evidence


def test_plain_dark_region_or_closed_surface_never_becomes_a_panel_box():
    for value in [0, 180, 255]:
        frame = np.full((480, 640, 3), value, dtype=np.uint8)
        assert panels.panel_aperture(frame, [.1, .1, .8, .9]) is None
    frame = np.full((480, 640, 3), 180, dtype=np.uint8)
    frame[80:300, 120:260] = 0
    assert panels.panel_aperture(frame, [.1, .1, .8, .9]) is None
    assert panels.panel_aperture(frame, [.8, .1, .1, .9]) is None


def test_safe_or_competing_panel_classification_never_localizes(monkeypatch):
    locate = Mock()
    monkeypatch.setattr(panels, 'localize_open_panel', locate)
    monkeypatch.setattr(behavior, '_presets', lambda: [dict(key='CAM-03', filenames=['test.mp4'], panel_search=[.1, .1, .3, .4])])
    for label, confidence, scores in [('Closed Panel Cover', .99, {}), ('Opened Panel Cover', .99, {'Closed Panel Cover': .9})]:
        output = InferenceOutput(type='classification', prediction=label, confidence=confidence, metrics={'class_scores': scores})
        behavior.verify_behavior(output, Path('test.mp4'), 'CAM-03')
        assert output.metrics['evidence_events'] == []
    locate.assert_not_called()


def test_panel_needs_sustained_visible_aperture_and_stops_when_it_disappears(monkeypatch):
    class Capture:
        index = 0
        def isOpened(self): return True
        def get(self, key): return {cv2.CAP_PROP_FPS: 4, cv2.CAP_PROP_FRAME_WIDTH: 640, cv2.CAP_PROP_FRAME_HEIGHT: 480}.get(key, 0)
        def read(self):
            self.index += 1
            return (True, np.zeros((480, 640, 3), np.uint8)) if self.index <= 20 else (False, None)
        def release(self): pass
    capture = Capture()
    monkeypatch.setattr(panels.cv2, 'VideoCapture', lambda _: capture)
    monkeypatch.setattr(panels, 'panel_aperture', lambda *_: [100., 100., 180., 230.] if capture.index <= 8 or capture.index >= 13 else None)
    output = InferenceOutput(type='classification', prediction='Opened Panel Cover', confidence=.99)
    panels.localize_open_panel(output, Path('test.mp4'), [.1, .1, .4, .6])
    assert output.metrics['verification'] == 'localized_panel'
    assert len(output.metrics['evidence_events']) == 1
    assert output.metrics['evidence_events'][0]['track_id'] == 'clip'
    assert output.metrics['evidence_events'][0]['bbox'] == [100., 100., 180., 230.]
    assert not any(2.1 <= row['timestamp_seconds'] < 3 for row in output.metrics['overlay_frames'])
    # A single fleeting observation cannot produce an event or a box.
    capture.index = 0
    monkeypatch.setattr(panels, 'panel_aperture', lambda *_: [100., 100., 180., 230.] if capture.index == 1 else None)
    panels.localize_open_panel(output, Path('test.mp4'), [.1, .1, .4, .6])
    assert output.metrics['evidence_events'] == [] and output.metrics['overlay_frames'] == []


def test_violation_categories_use_distinct_shared_colors():
    assert detection_color('Suspected no helmet') == (68, 68, 239)
    assert detection_color('Suspected no vest') == (11, 158, 245)
    assert detection_color('Opened Panel Cover') == (247, 85, 168)
    assert len({detection_color(label) for label in ['Suspected no helmet', 'Suspected no vest', 'Opened Panel Cover']}) == 3


def test_calibrated_interior_requires_visible_dark_textured_components():
    interior=[[.2,.2],[.45,.2],[.45,.65],[.2,.65]]
    frame=np.full((480,640,3),180,np.uint8)
    assert panels.panel_aperture(frame,[.1,.1,.6,.8],interior) is None
    frame[96:313,128:289]=0
    assert panels.panel_aperture(frame,[.1,.1,.6,.8],interior) is None # Blank black patch.
    rng=np.random.default_rng(42)
    texture=rng.choice([10,80],size=(217,161),p=[.60,.40]).astype(np.uint8)
    frame[96:313,128:289]=texture[:,:,None]
    box=panels.panel_aperture(frame,[.1,.1,.6,.8],interior)
    assert box is not None
    assert 127 <= box[0] < box[2] <= 290 and 95 <= box[1] < box[3] <= 314
    assert panels.panel_aperture(frame,[.1,.1,.6,.8],[[2,2]]*4) is None


def test_intervention_can_publish_separate_verified_panel_without_fabricated_score(monkeypatch):
    preset=dict(key='CAM-04',filenames=['test.mp4'],clip_views={'test.mp4':dict(panel_search=[.1,.1,.4,.6],panel_interior=[[.1,.1],[.3,.1],[.3,.5],[.1,.5]])})
    monkeypatch.setattr(behavior,'_presets',lambda:[preset])
    def localize(output,*args,**kwargs):
        assert kwargs['append'] is True
        output.metrics['panel_verification']='localized_panel'
        output.metrics['evidence_events'].append(dict(class_name='Opened Panel Cover',confidence=None,
            verified=True,bbox=[100,100,180,230],basis='visible_panel_aperture_and_intervention_context'))
    monkeypatch.setattr(panels,'localize_open_panel',localize)
    output=InferenceOutput(type='classification',prediction='Unauthorized Intervention',confidence=.96,metrics={'class_scores':{'Unauthorized Intervention':.96,'Opened Panel Cover':.001}})
    behavior.verify_behavior(output,Path('test.mp4'),'CAM-04')
    evidence=_classification_evidence(output)
    assert [row['class_name'] for row in evidence] == ['Unauthorized Intervention','Opened Panel Cover']
    assert evidence[1]['confidence'] is None
    output.metrics['panel_verification']='panel_not_visible'
    assert len(_classification_evidence(output)) == 1

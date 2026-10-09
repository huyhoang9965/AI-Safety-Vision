"""Short visual continuation of a detector-confirmed, still-visible head.

Forward/backward optical flow and current image texture must agree. This does
not seed people or infer PPE, and an old box alone never qualifies.
"""
from dataclasses import replace

import cv2
import numpy as np


def head_features(gray, person):
    h,w = gray.shape
    pw,ph = person.x2-person.x1,person.y2-person.y1
    x1,x2 = max(0,round(person.x1+pw*.15)),min(w,round(person.x2-pw*.15))
    y1,y2 = max(0,round(person.y1)),min(h,round(person.y1+min(ph*.30,pw*.65)))
    if x2-x1 < 10 or y2-y1 < 10:
        return None
    mask = np.zeros_like(gray)
    mask[y1:y2,x1:x2] = 255
    return cv2.goodFeaturesToTrack(gray,maxCorners=30,qualityLevel=.025,minDistance=2,mask=mask)


def continue_visible_person(previous, current, person, points):
    if points is None or len(points) < 4:
        return None
    forward,valid,_ = cv2.calcOpticalFlowPyrLK(previous,current,points,None,winSize=(15,15),maxLevel=2)
    if forward is None or valid is None:
        return None
    backward,reverse,_ = cv2.calcOpticalFlowPyrLK(current,previous,forward,None,winSize=(15,15),maxLevel=2)
    if backward is None or reverse is None:
        return None
    good = (valid.ravel() == 1) & (reverse.ravel() == 1) & (np.linalg.norm(backward-points,axis=2).ravel() < 1.2)
    if np.count_nonzero(good) < max(4,len(points)*.6):
        return None
    offsets = (forward-points)[good,0]
    dx,dy = np.median(offsets,axis=0)
    if np.median(np.linalg.norm(offsets-[dx,dy],axis=1)) > 1.5:
        return None
    if np.linalg.norm([dx,dy]) > max(8,(person.x2-person.x1)*.4):
        return None
    moved = replace(person,x1=person.x1+float(dx),x2=person.x2+float(dx),
        y1=person.y1+float(dy),y2=person.y2+float(dy),evidence_basis='detector_anchored_visual_track')
    h,w = current.shape
    if not (0 <= moved.x1 < moved.x2 <= w and 0 <= moved.y1 < moved.y2 <= h):
        return None
    # Test actual current head texture, including contrast. Unchanged factory
    # background or a uniform patch cannot carry a disappeared worker's box.
    pw,ph = person.x2-person.x1,person.y2-person.y1
    patch_size = (max(10,round(pw*.7)),max(10,round(min(ph*.30,pw*.65))))
    center = ((person.x1+person.x2)/2,person.y1+patch_size[1]/2)
    before = cv2.getRectSubPix(previous,patch_size,center)
    after = cv2.getRectSubPix(current,patch_size,(center[0]+float(dx),center[1]+float(dy)))
    if before.std() < 8 or after.std() < 8:
        return None
    correlation = float(cv2.matchTemplate(after,before,cv2.TM_CCOEFF_NORMED)[0,0])
    if not np.isfinite(correlation) or correlation < .75:
        return None
    return moved,forward[good].reshape(-1,1,2)

"""Shared category colors for browser boxes, annotated videos and PPE evidence."""
import json
from functools import lru_cache

from app.config import get_settings


@lru_cache(maxsize=1)
def _styles():
    return json.loads((get_settings().project_root / 'web/lib/detection-styles.json').read_text(encoding='utf-8'))


def detection_color(class_name: str, fallback=(56, 65, 230)):
    value = _styles().get(class_name, {}).get('color')
    if not value:
        return fallback
    return tuple(int(value[index:index + 2], 16) for index in (5, 3, 1))  # OpenCV BGR

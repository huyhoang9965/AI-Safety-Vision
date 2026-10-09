import presets from './demo-camera-presets.json';

export const CAMERA_DEMO_PRESETS = presets;

// Use the same curated clips in Demo, live monitoring and camera previews.
export function cameraDemoVideo<T extends { filename: string }>(videos: T[], code: string): T | undefined {
  const extraCameras: Record<string, [string, number]> = {
    'CAM-06': ['CAM-02', 1], 'CAM-07': ['CAM-03', 1],
    'CAM-08': ['CAM-04', 1], 'CAM-09': ['CAM-01', 1],
  };
  const [presetCode, clipIndex] = extraCameras[code] || [code, 0];
  const preset = CAMERA_DEMO_PRESETS.find(item => item.key === presetCode);
  const filename = preset?.filenames[clipIndex];
  return videos.find(video => video.filename === filename);
}

'use client';

import CameraPreviewVideo from './camera-preview-video';
import type { OverviewCamera, OverviewVideo } from './use-overview-data';
import styles from './overview.module.css';

export default function OverviewCameraPreview({ camera, videos, catalogLoading, enabled = true }: {
  camera: OverviewCamera; videos: OverviewVideo[] | null; catalogLoading: boolean; enabled?: boolean;
}) {
  return <div className={styles.cameraPreview}>
    <CameraPreviewVideo code={camera.code} name={camera.name} videos={videos} catalogLoading={catalogLoading} enabled={enabled} />
    <em>{camera.code}</em>
  </div>;
}
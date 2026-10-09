'use client';

import { useEffect, useRef, useState } from 'react';
import DetectionOverlay, { type OverlayFrame } from './detection-overlay';

export default function CameraVideoPlayer({ src, frames, width, height, label, onReady, onError, onEnded }: {
  src: string; frames: OverlayFrame[]; width: number; height: number;
  label: (name: string) => string; onReady: () => void; onError: () => void; onEnded: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [buffering, setBuffering] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false, handle = 0, lastTime = -1;
    const synchronize = () => {
      if (video.readyState >= 2 && !video.seeking && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        setTime(lastTime);
      }
    };
    // Update this small player at the displayed frame rate, without rendering
    // alert cards, history and all camera controls on every timeupdate.
    const frame = () => {
      if (stopped) return;
      synchronize();
      handle = video.requestVideoFrameCallback(frame);
    };
    if ('requestVideoFrameCallback' in video) handle = video.requestVideoFrameCallback(frame);
    else handle = window.setInterval(synchronize, 50);
    return () => {
      stopped = true;
      if ('requestVideoFrameCallback' in video) video.cancelVideoFrameCallback(handle);
      else window.clearInterval(handle);
    };
  }, [src]);

  return <>
    <video ref={videoRef} src={src} crossOrigin="anonymous" controls autoPlay muted playsInline preload="auto"
      onLoadedData={() => { setHasFrame(true); onReady(); }}
      onCanPlay={() => { setBuffering(false); onReady(); }}
      onPlaying={() => setBuffering(false)} onWaiting={() => setBuffering(true)}
      onSeeked={event => setTime(event.currentTarget.currentTime)}
      onTimeUpdate={event => { if (event.currentTarget.paused) setTime(event.currentTarget.currentTime); }}
      onError={onError} onEnded={onEnded} />
    {hasFrame && <DetectionOverlay frames={frames} time={time} width={width} height={height} label={label} />}
    {buffering && <span role="status" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', padding: '8px 12px', borderRadius: 8, background: 'rgba(15,23,42,.8)', color: '#fff', fontSize: 13, pointerEvents: 'none' }}>Đang tải thêm video…</span>}
  </>;
}

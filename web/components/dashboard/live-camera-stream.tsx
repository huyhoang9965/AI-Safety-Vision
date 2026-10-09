'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import styles from './live-monitoring.module.css';
import DetectionOverlay, { type OverlayFrame } from './detection-overlay';

const EMPTY_FRAMES: OverlayFrame[] = [];

export default function LiveCameraStream({ src, playing, muted, onElement, frames = EMPTY_FRAMES, frameWidth, frameHeight, label = name => name }: {
  src: string; playing: boolean; muted: boolean;
  onElement: (element: HTMLVideoElement | null) => void;
  frames?: OverlayFrame[]; label?: (name: string) => string;
  frameWidth?: number; frameHeight?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [time, setTime] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !frames.length || !ready) return;
    let stopped = false, handle = 0, last = -1;
    const synchronize = () => {
      if (video.readyState >= 2 && !video.seeking && video.currentTime !== last) {
        last = video.currentTime; setTime(last);
      }
    };
    const update = () => { if (!stopped) { synchronize(); handle = video.requestVideoFrameCallback(update); } };
    if ('requestVideoFrameCallback' in video) handle = video.requestVideoFrameCallback(update);
    else handle = window.setInterval(synchronize, 50);
    return () => { stopped = true; if ('requestVideoFrameCallback' in video) video.cancelVideoFrameCallback(handle); else window.clearInterval(handle); };
  }, [frames, ready, generation]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, muted, generation]);

  useEffect(() => {
    if (!failed || attempt >= 3) return;
    const timer = window.setTimeout(() => {
      setAttempt(current => current + 1);
      setGeneration(current => current + 1);
      setReady(false);
      setFailed(false);
    }, 1000 * 2 ** attempt);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);

  useEffect(() => {
    if (ready || failed) return;
    const timer = window.setTimeout(() => setFailed(true), 15000);
    return () => window.clearTimeout(timer);
  }, [ready, failed, generation]);

  const source = generation ? src + (src.includes('?') ? '&' : '?') + 'retry=' + generation : src;
  return <div className={styles.cameraViewport}>
    <video key={generation} ref={element => { videoRef.current = element; onElement(element); }}
      src={source} crossOrigin="anonymous" autoPlay={playing} muted={muted} loop playsInline preload="auto"
      onLoadedData={() => { setReady(true); setFailed(false); setAttempt(0); }}
      onSeeked={event => setTime(event.currentTarget.currentTime)}
      onTimeUpdate={event => { if (event.currentTarget.paused) setTime(event.currentTarget.currentTime); }}
      onError={() => { setReady(false); setFailed(true); }} />
    {ready && frames.length > 0 && videoRef.current && <DetectionOverlay frames={frames} time={time} width={frameWidth || videoRef.current.videoWidth} height={frameHeight || videoRef.current.videoHeight} label={label} />}
    {(!ready || failed) && <div className={styles.streamPlaceholder} role="status">
      {failed && attempt >= 3 ? <WifiOff size={21} /> : <LoaderCircle className={styles.spinning} size={21} />}
      <span>{failed ? attempt >= 3 ? 'Chưa kết nối được camera.' : 'Kết nối bị gián đoạn. Đang thử lại…' : 'Đang tải camera…'}</span>
      {failed && attempt >= 3 && <button type="button" onClick={event => {
        event.stopPropagation(); setAttempt(0); setFailed(false); setReady(false); setGeneration(current => current + 1);
      }}><RefreshCw size={15} /> Thử lại camera</button>}
    </div>}
  </div>;
}

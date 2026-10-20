'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, RefreshCw, Video, WifiOff } from 'lucide-react';
import { cameraDemoVideo } from '@/lib/demo-cameras';
import styles from './camera-preview-video.module.css';

export type CameraPreviewClip = { id: number; filename: string; stream_url?: string };
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export default function CameraPreviewVideo({ code, name, videos, catalogLoading = false, enabled = true }: {
  code: string; name: string; videos: CameraPreviewClip[] | null;
  catalogLoading?: boolean; enabled?: boolean;
}) {
  const clip = videos ? cameraDemoVideo(videos, code) : undefined;
  let source: string | null = null;
  try {
    if (clip) {
      const url = new URL(clip.stream_url || `/api/videos/${clip.id}/stream`, API_BASE + '/');
      if (['http:', 'https:'].includes(url.protocol)) source = url.href;
    }
  } catch { /* Malformed media URLs show the same missing-source state. */ }
  if (!source) return <div className={styles.viewport} role="status">
    <div className={styles.placeholder}>
      {catalogLoading ? <LoaderCircle size={25} className={styles.spinning} /> : <Video size={25} />}
      <span>{catalogLoading ? 'Đang tải nguồn video…' : 'Chưa có nguồn video cho camera này'}</span>
    </div>
  </div>;
  return <Stream key={source} src={source} code={code} name={name} enabled={enabled} />;
}

function Stream({ src, code, name, enabled }: { src: string; code: string; name: string; enabled: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inView = useRef(false);
  const userPaused = useRef(false);
  const hasFrame = useRef(false);
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    const container = viewport.current;
    if (!video || !container) return;
    const synchronize = () => {
      const visible = enabled && inView.current && document.visibilityState === 'visible';
      setActive(visible);
      if (!visible) video.pause();
      else if (!userPaused.current) void video.play().catch(error => {
        if (error instanceof DOMException && error.name === 'NotAllowedError') setBlocked(true);
      });
    };
    const observer = new IntersectionObserver(entries => {
      inView.current = entries[0]?.isIntersecting ?? false;
      synchronize();
    }, { threshold: 0.05 });
    observer.observe(container);
    document.addEventListener('visibilitychange', synchronize);
    return () => {
      inView.current = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', synchronize);
      video.pause();
    };
  }, [enabled, generation]);

  useEffect(() => {
    if (!active || failed || (ready && !buffering)) return;
    const timer = window.setTimeout(() => setFailed(true), 15000);
    return () => window.clearTimeout(timer);
  }, [active, ready, buffering, failed, generation]);

  useEffect(() => {
    if (!failed || attempt >= 3 || !active) return;
    const timer = window.setTimeout(() => {
      hasFrame.current = false;
      setAttempt(value => value + 1);
      setGeneration(value => value + 1);
      setReady(false); setBuffering(false); setFailed(false); setBlocked(false);
    }, 1000 * 2 ** attempt);
    return () => window.clearTimeout(timer);
  }, [failed, attempt, active]);

  const source = generation ? src + (src.includes('?') ? '&' : '?') + 'retry=' + generation : src;
  return <div ref={viewport} className={styles.viewport} aria-busy={active && !ready && !failed}>
    <video key={generation} ref={videoRef} src={source} aria-label={`Video camera ${code} ${name}`}
      controls muted loop playsInline preload="metadata" crossOrigin="anonymous"
      onLoadedData={() => { hasFrame.current = true; setReady(true); setFailed(false); setBuffering(false); }}
      onCanPlay={() => setBuffering(false)}
      onPlaying={() => { setReady(true); setBuffering(false); setBlocked(false); setAttempt(0); }}
      onPlay={() => { userPaused.current = false; setBlocked(false); }}
      onPause={event => {
        if (enabled && inView.current && document.visibilityState === 'visible' && hasFrame.current && !event.currentTarget.error) userPaused.current = true;
      }}
      onWaiting={() => setBuffering(true)}
      onError={() => { setFailed(true); setReady(false); setBuffering(false); }} />
    <span className={styles.sourceBadge}>VIDEO KIỂM THỬ</span>
    {(!ready || failed || blocked) && <div className={styles.placeholder} role="status">
      {failed && attempt >= 3 ? <WifiOff size={25} /> : blocked ? <Play size={25} /> : <LoaderCircle size={25} className={styles.spinning} />}
      <span>{failed ? attempt >= 3 ? 'Không tải được video camera.' : 'Kết nối gián đoạn. Đang thử lại…' : blocked ? 'Bấm Phát để xem video' : 'Đang tải video…'}</span>
      {failed && attempt >= 3 && <button type="button" aria-label={`Thử lại video ${code}`} onClick={() => {
        hasFrame.current = false; setAttempt(0); setGeneration(value => value + 1);
        setFailed(false); setReady(false); setBuffering(false); setBlocked(false);
      }}><RefreshCw size={15} />Thử lại video</button>}
      {blocked && <button type="button" aria-label={`Phát video ${code}`} onClick={() => {
        userPaused.current = false;
        void videoRef.current?.play().catch(() => setBlocked(true));
      }}><Play size={15} />Phát video</button>}
    </div>}
    {ready && buffering && !failed && <span className={styles.buffering} role="status">Đang tải thêm video…</span>}
  </div>;
}
'use client';

import {
  Activity,
  ArrowLeft,
  Bell,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  HardHat,
  Image as ImageIcon,
  LayoutDashboard,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Siren,
  Video,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { defaultAppPath, readAuthSession, restoreAuthSession } from '@/lib/auth';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

const CAMERA_PRESETS = [
  { key: 'CAM-01', filenames: ['0_tr10.mp4', '0_tr11.mp4'], location: 'Toàn cảnh xưởng', note: 'Lối đi sản xuất', roi: { left: 58, top: 12, width: 31, height: 73 } },
  { key: 'CAM-02', filenames: ['3_tr11.mp4', '3_tr14.mp4'], location: 'Khu vực xe nâng', note: 'Bãi trung chuyển', roi: { left: 8, top: 14, width: 62, height: 72 } },
  { key: 'CAM-03', filenames: ['2_tr123.mp4', '2_te12.mp4'], location: 'Tủ điện máy ép', note: 'Khu kỹ thuật', roi: { left: 4, top: 12, width: 49, height: 76 } },
  { key: 'CAM-04', filenames: ['1_tr25.mp4', '1_tr27.mp4'], location: 'Máy gia công', note: 'Khu vực hạn chế', roi: { left: 2, top: 16, width: 57, height: 76 } },
  { key: 'CAM-05', filenames: ['1_tr24.mp4', '1_tr60.mp4'], location: 'Lối đi chính', note: 'Giao cắt nội bộ', roi: { left: 52, top: 13, width: 39, height: 75 } },
];

const TOTAL_PIPELINE_JOBS = CAMERA_PRESETS.reduce((total, camera) => total + camera.filenames.length * 2, 0);

const UNSAFE_BEHAVIORS = new Set([
  'Safe Walkway Violation',
  'Unauthorized Intervention',
  'Opened Panel Cover',
  'Carrying Overload with Forklift',
]);

const LABELS_VI = {
  'Safe Walkway Violation': 'Đi vào khu vực nguy hiểm',
  'Unauthorized Intervention': 'Can thiệp trái phép',
  'Opened Panel Cover': 'Nắp tủ điện đang mở',
  'Carrying Overload with Forklift': 'Xe nâng chở quá tải',
  'Authorized Intervention': 'Can thiệp đã được phép',
  'Closed Panel Cover': 'Nắp tủ điện đã đóng',
  'Safe Carrying': 'Vận chuyển an toàn',
  'Safe Walkway': 'Di chuyển đúng lối đi',
};

function apiUrl(path) {
  if (!path) return '';
  return /^https?:\/\//.test(path) ? path : `${API_BASE}${path}`;
}

function authHeaders(json = false) {
  const stored = readAuthSession();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(stored ? { Authorization: `Bearer ${stored.session.access_token}` } : {}),
  };
}

async function responseError(response, fallback) {
  const payload = await response.json().catch(() => null);
  if (typeof payload?.detail === 'string') return payload.detail;
  if (typeof payload?.detail?.message === 'string') return payload.detail.message;
  return fallback;
}

function translateLabel(label) {
  return LABELS_VI[label] || label;
}

function severityFor(label) {
  if (label.includes('Unauthorized') || label.includes('helmet')) return { label: 'Nghiêm trọng', tone: 'critical' };
  if (label.includes('Overload') || label.includes('Opened')) return { label: 'Cao', tone: 'high' };
  return { label: 'Trung bình', tone: 'medium' };
}

function formatNow() {
  const now = new Date();
  return {
    time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: now.toLocaleDateString('vi-VN'),
  };
}

function buildBehaviorAlert(camera, result) {
  if (!UNSAFE_BEHAVIORS.has(result.prediction)) return null;
  const severity = severityFor(result.prediction);
  const occurred = formatNow();
  const evidence = result?.metrics?.evidence_events?.find((event) => event.class_name === result.prediction);
  return {
    id: `${camera.key}-${camera.video.id}-videomae-${result.prediction}`,
    camera: camera.key,
    location: camera.location,
    title: translateLabel(result.prediction),
    rawLabel: result.prediction,
    model: 'VideoMAE · best_stage3.pt',
    type: 'behavior',
    confidence: Number(result.confidence || 0),
    severity,
    time: occurred.time,
    date: occurred.date,
    status: 'Mới',
    videoId: camera.video.id,
    image: apiUrl(evidence?.image || `/api/videos/${camera.video.id}/thumbnail`),
    eventId: result.event_ids?.[0] || null,
    savedToDashboard: Boolean(result.persisted && result.event_ids?.[0]),
    evidenceVideo: '',
    roi: camera.roi,
    detail: 'VideoMAE phân tích chuỗi khung hình và nhận diện hành vi có nguy cơ mất an toàn.',
  };
}

function buildPpeAlerts(camera, result) {
  const occurred = formatNow();
  const labels = {
    'Suspected no helmet': 'Nghi ngờ không đội mũ bảo hộ',
    'Suspected no vest': 'Nghi ngờ không mặc áo bảo hộ',
  };
  return (result?.metrics?.evidence_events || []).filter((event) => labels[event.class_name] && event.image).map((event, index) => ({
    id: `${camera.key}-${camera.video.id}-person-${event.track_id}-${event.class_name}`,
    camera: camera.key,
    location: camera.location,
    title: labels[event.class_name],
    rawLabel: event.class_name,
    model: 'RF-DETR · PPE detection',
    type: 'ppe',
    confidence: null,
    severity: { label: 'Cần kiểm tra', tone: 'high' },
    time: occurred.time,
    date: occurred.date,
    status: 'Cần xác minh',
    videoId: camera.video.id,
    personId: event.track_id,
    frameIndex: event.frame_index,
    timestampSeconds: event.timestamp_seconds,
    image: apiUrl(event.image),
    fullFrameImage: apiUrl(`/api/videos/${camera.video.id}/thumbnail?frame_index=${Math.max(0, Number(event.frame_index) || 0)}`),
    eventId: result.event_ids?.[index] || null,
    savedToDashboard: Boolean(result.persisted && result.event_ids?.[index]),
    evidenceVideo: '',
    processedVideo: apiUrl(result.output_video),
    roi: null,
    detail: `Người #${event.track_id}, tại giây ${event.timestamp_seconds.toFixed(1)} của clip. Đã xác định được người; RF-DETR chưa quan sát thấy ${event.class_name === 'Suspected no helmet' ? 'mũ tại vùng đầu' : 'áo bảo hộ tại vùng thân'} trong hai lần kiểm tra liên tiếp. Cần xác minh ảnh, vì vật che khuất hoặc PPE nhỏ có thể gây bỏ sót.`,
  }));
}

function getErrorMessage(payload) {
  if (typeof payload?.detail === 'string') return payload.detail;
  return payload?.detail?.message || 'Không thể phân tích video.';
}

export default function DemoPage() {
  const [dashboardHref, setDashboardHref] = useState('');
  const [videos, setVideos] = useState([]);
  const [models, setModels] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [reloadCatalog, setReloadCatalog] = useState(0);
  const [videoError, setVideoError] = useState('');
  const [videoReady, setVideoReady] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [activeCamera, setActiveCamera] = useState('CAM-01');
  const [activeClipIndexes, setActiveClipIndexes] = useState({});
  const [backendOnline, setBackendOnline] = useState(false);
  const [databaseStatus, setDatabaseStatus] = useState('unknown');
  const [jobs, setJobs] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [syncWarning, setSyncWarning] = useState('');
  const [toast, setToast] = useState(null);
  const [historyTab, setHistoryTab] = useState('history');
  const [selectedAlertId, setSelectedAlertId] = useState('');
  const [notificationPermission, setNotificationPermission] = useState('default');
  const autoStarted = useRef(false);
  const publishedAlertIds = useRef(new Set());

  useEffect(() => {
    try {
      const storedSession = readAuthSession();
      if (storedSession) setDashboardHref(defaultAppPath(storedSession.session.user) || '');

      const cached = window.sessionStorage.getItem('ai-safety-alert-history-person-v1');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          parsed.forEach((alert) => publishedAlertIds.current.add(alert.id));
          setAlerts(parsed.map((alert) => ({ ...alert, savedToDashboard: alert.savedToDashboard === true })));
          setSelectedAlertId(parsed[0]?.id || '');
        }
      }
      if ('Notification' in window) setNotificationPermission(window.Notification.permission);
    } catch {
      // Session storage and browser notifications are optional enhancements.
    } finally {
      setHistoryHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!historyHydrated) return;
    try {
      window.sessionStorage.setItem('ai-safety-alert-history-person-v1', JSON.stringify(alerts));
    } catch {
      // Keep the live dashboard operational when storage is unavailable.
    }
  }, [alerts, historyHydrated]);

  useEffect(() => {
    const controller = new AbortController();
    const loadCatalog = async () => {
      setCatalogLoading(true);
      setCatalogError('');
      try {
        const session = await restoreAuthSession();
        if (!session) {
          throw new Error('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để xem camera Demo.');
        }
        setDashboardHref(defaultAppPath(session.user) || '');
        const headers = { Authorization: `Bearer ${session.access_token}` };
        const [videoResponse, modelResponse, healthResponse] = await Promise.all([
          fetch(`${API_BASE}/api/videos/test`, { headers, signal: controller.signal }),
          fetch(`${API_BASE}/api/models`, { headers, signal: controller.signal }),
          fetch(`${API_BASE}/api/health`, { signal: controller.signal }),
        ]);
        setBackendOnline(healthResponse.ok);
        if (!videoResponse.ok) {
          throw new Error(await responseError(videoResponse, 'Không thể tải danh sách camera Demo.'));
        }
        if (!modelResponse.ok) {
          throw new Error(await responseError(modelResponse, 'Không thể tải trạng thái mô hình AI.'));
        }
        if (!healthResponse.ok) throw new Error('Backend chưa sẵn sàng.');
        const [videoCatalog, modelCatalog, health] = await Promise.all([
          videoResponse.json(), modelResponse.json(), healthResponse.json(),
        ]);
        setVideos(videoCatalog);
        setModels(modelCatalog);
        setDatabaseStatus(health.database || 'unknown');
        setBackendOnline(true);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setCatalogError(error instanceof Error ? error.message : 'Không thể kết nối camera Demo.');
        }
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    };
    loadCatalog();
    return () => controller.abort();
  }, [reloadCatalog]);

  useEffect(() => {
    const readyCameras = CAMERA_PRESETS.map((preset) => ({
      ...preset,
      clips: preset.filenames.map((filename) => videos.find((video) => video.filename === filename)).filter(Boolean),
    })).filter((camera) => camera.clips.length === camera.filenames.length);
    const connected = new Set(models.filter((model) => model.connected).map((model) => model.name));
    if (autoStarted.current || readyCameras.length !== CAMERA_PRESETS.length || !connected.has('RF-DETR') || !connected.has('VideoMAE')) return;
    autoStarted.current = true;

    const setJob = (camera, model, status, message = '') => {
      setJobs((current) => ({ ...current, [`${camera.key}:${camera.video.id}:${model}`]: { status, message } }));
    };

    const publishAlert = (alert) => {
      if (!alert) return;
      const alreadyShown = publishedAlertIds.current.has(alert.id);
      if (alreadyShown && !alert.savedToDashboard) return;
      publishedAlertIds.current.add(alert.id);
      setAlerts((current) => alreadyShown
        ? current.map((item) => item.id === alert.id ? { ...item, ...alert } : item)
        : [alert, ...current]);
      if (alreadyShown) return;
      setSelectedAlertId((current) => current || alert.id);
      setToast(alert);
      window.setTimeout(() => setToast((current) => current?.id === alert.id ? null : current), 6500);
      if ('Notification' in window && window.Notification.permission === 'granted') {
        new window.Notification(`Cảnh báo ${alert.camera}`, { body: alert.title });
      }
    };

    const infer = async (camera, model) => {
      setJob(camera, model, 'running');
      try {
        const response = await fetch(`${API_BASE}/api/inference`, {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ video_id: Number(camera.video.id), model_name: model, camera_code: camera.key }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(getErrorMessage(payload));
        setJob(camera, model, payload.persisted ? 'done' : 'error', payload.persisted ? '' : 'Kết quả AI chưa lưu được vào Dashboard');
        if (!payload.persisted) setSyncWarning('Một số kết quả AI chưa lưu được vào Dashboard. Hãy kiểm tra backend và tải lại trang Demo để phân tích lại.');
        if (model === 'VideoMAE') {
          publishAlert(buildBehaviorAlert(camera, payload));
        } else {
          buildPpeAlerts(camera, payload).forEach(publishAlert);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Không thể phân tích video.';
        setJob(camera, model, 'error', message);
        setSyncWarning(`Không thể hoàn tất phân tích ${model} cho ${camera.key}: ${message}`);
      }
    };

    const runAutomaticPipeline = async () => {
      const clips = readyCameras.flatMap((camera) => camera.clips.map((video, clipIndex) => ({ ...camera, video, clipIndex })));
      const primaryClips = readyCameras.map((camera) => ({ ...camera, video: camera.clips[0], clipIndex: 0 }));
      const secondaryClips = clips.filter((camera) => camera.clipIndex > 0);
      const ppeDemoClip = clips.find((camera) => camera.video.filename === '1_tr25.mp4');

      // Run one representative PPE clip first so the live dashboard can publish
      // a spatial violation alert without waiting for every behavior job.
      if (ppeDemoClip) await infer(ppeDemoClip, 'RF-DETR');

      // Give every camera a first result before processing its secondary clip.
      // This keeps the 4-core CPU responsive and makes progress visible sooner.
      for (const camera of primaryClips) {
        await infer(camera, 'VideoMAE');
        if (camera.video.id !== ppeDemoClip?.video.id) await infer(camera, 'RF-DETR');
      }
      for (const camera of secondaryClips) {
        await infer(camera, 'VideoMAE');
        if (camera.video.id !== ppeDemoClip?.video.id) await infer(camera, 'RF-DETR');
      }
    };
    runAutomaticPipeline();
  }, [models, videos]);

  const cameras = CAMERA_PRESETS.map((preset) => ({
    ...preset,
    clips: preset.filenames.map((filename) => videos.find((video) => video.filename === filename)).filter(Boolean),
  }));
  const selectedCamera = cameras.find((camera) => camera.key === activeCamera) || cameras[0];
  const selectedClipIndex = activeClipIndexes[activeCamera] || 0;
  const selectedVideo = selectedCamera?.clips[selectedClipIndex] || selectedCamera?.clips[0];
  const selectedAlert = alerts.find((alert) => alert.id === selectedAlertId) || alerts[0];
  const unsyncedCount = alerts.filter((alert) => !alert.savedToDashboard).length;
  const jobValues = Object.values(jobs);
  const completedJobs = jobValues.filter((job) => job.status === 'done' || job.status === 'error').length;
  const totalJobs = TOTAL_PIPELINE_JOBS;
  const activeCameraAlerts = alerts.filter((alert) => alert.camera === activeCamera);
  const activePpeAlert = activeCameraAlerts.find((alert) => alert.type === 'ppe' && alert.videoId === selectedVideo?.id && alert.processedVideo);
  const activeBehaviorAlert = activePpeAlert ? null : activeCameraAlerts.find((alert) => alert.type === 'behavior' && alert.videoId === selectedVideo?.id && alert.roi);
  const rawCameraVideoSource = activePpeAlert?.processedVideo || apiUrl(selectedVideo?.stream_url);
  const cameraVideoSource = rawCameraVideoSource
    ? `${rawCameraVideoSource}${rawCameraVideoSource.includes('?') ? '&' : '?'}attempt=${streamAttempt}`
    : '';

  useEffect(() => {
    setVideoError('');
    setVideoReady(false);
  }, [selectedVideo?.id]);

  const cameraState = (camera) => {
    const cameraJobs = camera.clips.flatMap((clip) => [jobs[`${camera.key}:${clip.id}:VideoMAE`], jobs[`${camera.key}:${clip.id}:RF-DETR`]]).filter(Boolean);
    if (cameraJobs.some((job) => job.status === 'running')) return 'Đang quét';
    if (cameraJobs.some((job) => job.status === 'error')) return 'Có lỗi phân tích';
    if (cameraJobs.length === camera.clips.length * 2 && cameraJobs.every((job) => job.status === 'done' || job.status === 'error')) return 'Đã kiểm tra';
    if (cameraJobs.some((job) => job.status === 'done')) return 'Đang tiếp tục';
    return 'Đang chờ';
  };

  const advanceCameraClip = () => {
    if (!selectedCamera?.clips.length) return;
    setActiveClipIndexes((current) => ({
      ...current,
      [activeCamera]: ((current[activeCamera] || 0) + 1) % selectedCamera.clips.length,
    }));
  };

  const updateAlertStatus = async (id, status) => {
    const alert = alerts.find((item) => item.id === id);
    if (!alert?.savedToDashboard || !alert.eventId) {
      setSyncWarning('Cảnh báo này chưa được lưu vào Dashboard. Hãy tải lại Demo để phân tích và đồng bộ trước khi xử lý.');
      return;
    }
    const action = status === 'Báo sai' ? 'dismiss' : 'acknowledge';
    if (action === 'acknowledge' && ['Đang xử lý', 'Đã xác nhận'].includes(alert.status)) {
      setAlerts((current) => current.map((item) => item.id === id ? { ...item, status } : item));
      return;
    }
    try {
      const session = await restoreAuthSession();
      if (!session) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      const response = await fetch(`${API_BASE}/api/alerts/${alert.eventId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ note: action === 'dismiss' ? 'Đánh dấu báo sai từ trang Demo' : null }),
      });
      if (!response.ok) throw new Error(await responseError(response, 'Không thể cập nhật cảnh báo trong Dashboard.'));
      setAlerts((current) => current.map((item) => item.id === id ? { ...item, status } : item));
      setSyncWarning('');
    } catch (error) {
      setSyncWarning(error instanceof Error ? error.message : 'Không thể cập nhật cảnh báo trong Dashboard.');
    }
  };

  const enableNotifications = async () => {
    if (!('Notification' in window)) return;
    const permission = await window.Notification.requestPermission();
    setNotificationPermission(permission);
  };

  return (
    <main className="monitoring-demo">
      {toast && (
        <button className="alert-toast" type="button" onClick={() => { setSelectedAlertId(toast.id); setToast(null); document.getElementById('violation-history')?.scrollIntoView({ behavior: 'smooth' }); }}>
          <span><Siren size={18} /></span><div><small>CẢNH BÁO MỚI · {toast.camera}</small><strong>{toast.title}</strong></div>
        </button>
      )}

      <header className="monitor-header">
        <Link href="/" className="monitor-brand"><span><ShieldCheck size={21} /></span><div><strong>AI Safety</strong><small>Trung tâm giám sát</small></div></Link>
        <div className="monitor-header-actions">
          {notificationPermission !== 'granted' && <button type="button" onClick={enableNotifications}><Bell size={15} /> Bật thông báo</button>}
          <span className={backendOnline ? '' : 'offline'}><i />{backendOnline ? 'Hệ thống trực tuyến' : 'Mất kết nối'}</span>
          {dashboardHref
            ? <Link href={dashboardHref}><LayoutDashboard size={16} /> Quay lại Dashboard</Link>
            : <Link href="/"><ArrowLeft size={16} /> Trang chủ</Link>}
        </div>
      </header>

      <div className="monitor-shell">
        {(syncWarning || unsyncedCount > 0) && (
          <div className="demo-sync-warning" role="status">
            <Database size={17} />
            <span>{unsyncedCount > 0 ? `${unsyncedCount} cảnh báo chỉ đang lưu trong trình duyệt. Tải lại Demo để phân tích và đồng bộ; cảnh báo đã lưu sẽ xuất hiện trong Dashboard.` : syncWarning}</span>
            {dashboardHref && <Link href="/dashboard/alerts">Xem cảnh báo Dashboard</Link>}
          </div>
        )}
        <section className="monitor-titlebar">
          <div><span className="monitor-kicker">AUTOMATIC SAFETY MONITORING</span><h1>Giám sát an toàn tự động</h1><p>Hai mô hình chuyên trách tự phân tích camera và phát cảnh báo khi phát hiện rủi ro.</p></div>
          <div className="monitor-summary">
            <span><Camera size={17} /><strong>05</strong><small>Camera</small></span>
            <span><Bell size={17} /><strong>{alerts.length}</strong><small>Vi phạm</small></span>
            <span><Activity size={17} /><strong>{completedJobs}/{totalJobs}</strong><small>Tác vụ clip × AI</small></span>
          </div>
        </section>

        <section className="monitor-grid">
          <article className="camera-panel panel">
            <div className="panel-heading">
              <div><Camera size={18} /><span><strong>Camera giám sát</strong><small>{selectedCamera?.location}</small></span></div>
              <span className="camera-id">{selectedCamera?.key}</span>
            </div>
            <div className="camera-stage">
              {selectedVideo && !videoError
                ? <video key={`${selectedVideo.id}-${cameraVideoSource}`} src={cameraVideoSource} controls autoPlay muted playsInline preload="metadata" onCanPlay={() => { setVideoReady(true); setVideoError(''); }} onError={() => setVideoError('Không thể tải luồng video kiểm thử.')} onEnded={advanceCameraClip} />
                : <div className={`camera-placeholder ${catalogError || videoError ? 'error' : ''}`}>
                    {catalogLoading
                      ? <><LoaderCircle className="spin" size={27} /><span><strong>Đang kết nối camera</strong><small>Đang xác thực và tải nguồn video...</small></span></>
                      : <><WifiOff size={27} /><span><strong>Chưa thể kết nối camera</strong><small>{videoError || catalogError || 'Không tìm thấy video kiểm thử phù hợp.'}</small></span><button type="button" onClick={() => { setVideoError(''); setStreamAttempt(value => value + 1); if (!selectedVideo) setReloadCatalog(value => value + 1); }}><RefreshCw size={14} /> Thử kết nối lại</button></>}
                  </div>}
              {selectedVideo && !videoError && <div className="camera-live"><i /> TRỰC TIẾP</div>}
              {selectedVideo && !videoError && <div className="camera-ai"><Activity className={cameraState(selectedCamera).includes('Đang') ? 'pulse' : ''} size={14} />{videoReady ? cameraState(selectedCamera) : 'Đang mở luồng'}</div>}
              {activeBehaviorAlert && <div className="violation-roi" style={{ left: `${activeBehaviorAlert.roi.left}%`, top: `${activeBehaviorAlert.roi.top}%`, width: `${activeBehaviorAlert.roi.width}%`, height: `${activeBehaviorAlert.roi.height}%` }}><span>{activeBehaviorAlert.title}</span></div>}
              <div className="camera-caption"><span><MapPin size={14} />{selectedCamera?.note} · Clip {selectedClipIndex + 1}/{selectedCamera?.clips.length || 1}</span><span>{activePpeAlert?.title || activeBehaviorAlert?.title || 'AI đang quan sát khu vực'}</span></div>
            </div>
            <div className="camera-tabs" role="tablist">
              {cameras.map((camera) => (
                <button type="button" role="tab" aria-selected={activeCamera === camera.key} className={activeCamera === camera.key ? 'active' : ''} key={camera.key} onClick={() => setActiveCamera(camera.key)} disabled={!camera.clips.length}>
                  <span>{camera.key}</span><small>{cameraState(camera)}</small>
                </button>
              ))}
            </div>
            <div className="auto-pipeline">
              <div className="pipeline-title"><Activity size={16} /><span><strong>Phân tích tự động</strong><small>Không cần thao tác thủ công</small></span></div>
              <div className="pipeline-model"><HardHat size={16} /><span><strong>RF-DETR</strong><small>PPE · mũ bảo hộ</small></span><i className={models.find((model) => model.name === 'RF-DETR')?.connected ? 'ready' : ''} /></div>
              <div className="pipeline-model"><Video size={16} /><span><strong>VideoMAE Stage 3</strong><small>Hành vi · vùng nguy hiểm</small></span><i className={models.find((model) => model.name === 'VideoMAE')?.connected ? 'ready' : ''} /></div>
              <div className="pipeline-progress"><span>{completedJobs < totalJobs ? 'Đang phân tích' : 'Đã hoàn tất'}</span><strong>{completedJobs}/{totalJobs}</strong><div><i style={{ width: `${(completedJobs / totalJobs) * 100}%` }} /></div><small>Không giới hạn số vi phạm phát hiện.</small></div>
            </div>
          </article>

          <aside className="alerts-panel panel">
            <div className="panel-heading"><div><Siren size={18} /><span><strong>Cảnh báo thời gian thực</strong><small>Kết quả từ hai mô hình AI</small></span></div><span className="alert-count">{alerts.filter((alert) => alert.status !== 'Đã đóng').length}</span></div>
            <div className="alert-list">
              {alerts.map((alert) => (
                <article className={`alert-item ${alert.severity.tone}`} key={alert.id}>
                  <div className="alert-topline"><span className={`severity ${alert.severity.tone}`}>{alert.severity.label}</span><small>{alert.model.split(' · ')[0]}</small></div>
                  <h2>{alert.title}</h2>
                  {!alert.savedToDashboard && <small className="demo-alert-unsynced">Chưa lưu Dashboard</small>}
                  <p>{alert.camera} · {alert.time}</p>
                  <div className="alert-actions"><button type="button" onClick={() => { updateAlertStatus(alert.id, 'Đang xử lý'); setSelectedAlertId(alert.id); }}>Xác nhận xử lý</button><span>{alert.status}</span></div>
                </article>
              ))}
              {alerts.length === 0 && <div className="scanning-empty"><span><LoaderCircle className="spin" size={25} /></span><strong>AI đang phân tích camera</strong><small>Cảnh báo sẽ xuất hiện ngay khi phát hiện vi phạm.</small></div>}
            </div>
            <div className="alerts-footer"><Wifi size={15} /><span>Kết nối máy chủ ổn định</span><i /></div>
          </aside>
        </section>

        <section className="history-section panel" id="violation-history">
          <div className="history-tabs">
            <button className={historyTab === 'stats' ? 'active' : ''} type="button" onClick={() => setHistoryTab('stats')}>Thống kê sự cố</button>
            <button className={historyTab === 'history' ? 'active' : ''} type="button" onClick={() => setHistoryTab('history')}>Lịch sử vi phạm <span>{alerts.length}</span></button>
          </div>

          {historyTab === 'stats' ? (
            <div className="stats-view">
              <div><small>Tổng vi phạm</small><strong>{alerts.length}</strong></div>
              <div><small>Nghiêm trọng</small><strong>{alerts.filter((alert) => alert.severity.tone === 'critical').length}</strong></div>
              <div><small>Đang xử lý</small><strong>{alerts.filter((alert) => alert.status === 'Đang xử lý').length}</strong></div>
              <div><small>Đã xác nhận</small><strong>{alerts.filter((alert) => alert.status === 'Đã xác nhận').length}</strong></div>
              <article><h3>Theo mô hình</h3><p><span>VideoMAE Stage 3</span><strong>{alerts.filter((alert) => alert.type === 'behavior').length}</strong></p><p><span>RF-DETR</span><strong>{alerts.filter((alert) => alert.type === 'ppe').length}</strong></p></article>
            </div>
          ) : alerts.length ? (
            <div className="history-workspace">
              <div className="history-list">
                {alerts.map((alert) => (
                  <button className={selectedAlert?.id === alert.id ? 'active' : ''} type="button" key={alert.id} onClick={() => setSelectedAlertId(alert.id)}>
                    <i /><span className={`severity ${alert.severity.tone}`}>{alert.severity.label}</span><span><strong>{alert.title}</strong><small>{alert.camera} · {alert.time} {alert.date}</small></span><em>{alert.status}</em>
                  </button>
                ))}
              </div>
              <article className="history-detail">
                {selectedAlert.image && <a className="evidence-original" href={selectedAlert.image} target="_blank" rel="noopener noreferrer">Mở ảnh bằng chứng gốc ↗</a>}
                <div className="detail-heading"><div><span className={`severity ${selectedAlert.severity.tone}`}>{selectedAlert.severity.label}</span><h2>{selectedAlert.title}</h2><p>{selectedAlert.camera} · {selectedAlert.location}</p></div><span>{selectedAlert.status}</span></div>
                <div className="detail-meta"><span><small>MÔ HÌNH</small>{selectedAlert.model}</span><span><small>ĐỘ TIN CẬY</small>{selectedAlert.confidence == null ? 'Cần xác minh' : `${(selectedAlert.confidence * 100).toFixed(1)}%`}</span><span><small>THỜI GIAN</small>{selectedAlert.time}</span></div>
                <p className="detail-description">{selectedAlert.detail}</p>
                <div className="evidence"><span><ImageIcon size={14} /> ẢNH BẰNG CHỨNG · PHÓNG VỪA KHUNG</span><div className="evidence-media"><img src={selectedAlert.image} alt={`Bằng chứng ${selectedAlert.camera}`} /></div></div>
                {selectedAlert.type === 'ppe' && selectedAlert.fullFrameImage && <a className="evidence-context" href={selectedAlert.fullFrameImage} target="_blank" rel="noopener noreferrer">Xem toàn bộ khung hình tại thời điểm vi phạm ↗</a>}
                <div className="review-actions"><button type="button" onClick={() => updateAlertStatus(selectedAlert.id, 'Đã xác nhận')}><CheckCircle2 size={15} /> Xác nhận sự cố</button><button type="button" onClick={() => updateAlertStatus(selectedAlert.id, 'Báo sai')}><XCircle size={15} /> Đánh dấu báo sai</button></div>
              </article>
            </div>
          ) : (
            <div className="empty-history"><Eye size={28} /><strong>Chưa ghi nhận vi phạm</strong><span>Hai mô hình đang tự động phân tích 5 camera.</span></div>
          )}
        </section>

        <section className="system-note panel"><Database size={17} /><div><strong>Pipeline đang hoạt động tự động</strong><small>VideoMAE được ưu tiên quét hành vi trước, RF-DETR tiếp tục kiểm tra PPE. {databaseStatus === 'connected' ? 'Kết quả được lưu trong PostgreSQL.' : 'Kết quả đang lưu trong phiên trình duyệt.'}</small></div><span>{backendOnline ? 'ONLINE' : 'OFFLINE'}</span></section>
        <footer className="monitor-footer"><span>AI Safety Monitoring</span><span>RF-DETR + VideoMAE best_stage3</span></footer>
      </div>

      <style>{`
        .monitoring-demo{--ink:#17202a;--muted:#697887;--line:#dce4e9;--blue:#2f6fed;--soft:#f5f8fa;min-height:100svh;color:var(--ink);background:#eef3f6;color-scheme:light}.monitor-header{height:72px;padding:0 clamp(20px,4vw,64px);display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:30;backdrop-filter:blur(14px)}
        .monitor-brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none}.monitor-brand>span{width:38px;height:38px;display:grid;place-items:center;color:#fff;background:var(--blue);border-radius:10px;box-shadow:0 7px 18px rgba(47,111,237,.2)}.monitor-brand div{display:flex;flex-direction:column}.monitor-brand strong{font-size:15px}.monitor-brand small{color:var(--muted);font-size:10px;margin-top:2px}.monitor-header-actions{display:flex;align-items:center;gap:23px}.monitor-header-actions>button,.monitor-header-actions>a,.monitor-header-actions>span{display:flex;align-items:center;gap:7px;color:#536273;font-size:10px;text-decoration:none}.monitor-header-actions>button{padding:8px 10px;border:1px solid var(--line);border-radius:7px}.monitor-header-actions>span i{width:7px;height:7px;border-radius:50%;background:#2aa66f}.monitor-header-actions>span.offline i{background:#d45d5d}
        .monitor-shell{width:min(1500px,calc(100% - 48px));margin:0 auto}.monitor-titlebar{padding:39px 0 28px;display:flex;justify-content:space-between;align-items:end;gap:30px}.monitor-kicker{color:var(--blue);font-size:9px;font-weight:700;letter-spacing:.14em}.monitor-titlebar h1{margin-top:8px;font-size:clamp(26px,3vw,40px);font-weight:650;letter-spacing:-.035em}.monitor-titlebar p{margin-top:8px;color:var(--muted);font-size:13px}.monitor-summary{display:flex;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 5px 18px rgba(31,53,72,.04)}.monitor-summary>span{min-width:118px;padding:12px 16px;display:grid;grid-template-columns:21px 1fr;align-items:center;border-left:1px solid var(--line)}.monitor-summary>span:first-child{border-left:0}.monitor-summary svg{grid-row:1/3;color:#7b8b99}.monitor-summary strong{font-size:16px}.monitor-summary small{color:var(--muted);font-size:9px}
        .panel{border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 12px 35px rgba(30,51,68,.055);overflow:hidden}.monitor-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(320px,.72fr);gap:18px;align-items:start}.panel-heading{min-height:64px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.panel-heading>div{display:flex;align-items:center;gap:11px}.panel-heading>div>svg{color:var(--blue)}.panel-heading>div>span{display:flex;flex-direction:column;gap:3px}.panel-heading strong{font-size:13px}.panel-heading small{color:var(--muted);font-size:9px}.camera-id{padding:7px 10px;color:#44617d;background:#edf3f8;border-radius:7px;font-size:10px;font-weight:700}
        .camera-stage{position:relative;aspect-ratio:16/8.45;overflow:hidden;background:#111a21}.camera-stage video{width:100%;height:100%;display:block;object-fit:cover}.camera-placeholder{height:100%;padding:22px;display:flex;align-items:center;justify-content:center;gap:12px;color:#cbd3d8;font-size:12px;text-align:left}.camera-placeholder>span{display:flex;max-width:390px;flex-direction:column;gap:4px}.camera-placeholder strong{color:#eef3f6;font-size:14px}.camera-placeholder small{color:#93a3ad;font-size:11px;line-height:1.45}.camera-placeholder button{height:34px;padding:0 11px;display:inline-flex;align-items:center;gap:6px;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:#2f6fed;font-size:11px;font-weight:700;white-space:nowrap}.camera-placeholder.error>svg{color:#ef9292}.camera-live,.camera-ai{position:absolute;top:15px;display:flex;align-items:center;gap:7px;padding:7px 9px;color:#fff;background:rgba(17,28,36,.78);border-radius:6px;font-size:8px;font-weight:700;letter-spacing:.06em;pointer-events:none}.camera-live{left:15px}.camera-live i{width:6px;height:6px;border-radius:50%;background:#f36363;box-shadow:0 0 0 4px rgba(243,99,99,.16)}.camera-ai{right:15px}.pulse{animation:pulse 1.25s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}.camera-caption{position:absolute;left:0;right:0;bottom:38px;padding:35px 18px 12px;display:flex;justify-content:space-between;gap:20px;color:#fff;background:linear-gradient(transparent,rgba(8,14,18,.75));font-size:10px;pointer-events:none}.camera-caption span{display:flex;align-items:center;gap:6px}.camera-caption span:last-child{color:#dbe2e6}.violation-roi{position:absolute;z-index:4;border:2px solid #ef4444;box-shadow:0 0 0 1px rgba(255,255,255,.42),0 0 18px rgba(239,68,68,.24);pointer-events:none}.violation-roi:before,.violation-roi:after{content:'';position:absolute;width:14px;height:14px;border-color:#fff}.violation-roi:before{left:-2px;top:-2px;border-left:3px solid;border-top:3px solid}.violation-roi:after{right:-2px;bottom:-2px;border-right:3px solid;border-bottom:3px solid}.violation-roi>span{position:absolute;left:-2px;top:-24px;padding:5px 7px;color:#fff;background:#d93636;font-size:7px;font-weight:700;white-space:nowrap}
        .camera-tabs{padding:13px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;border-bottom:1px solid var(--line)}.camera-tabs button{min-width:0;padding:10px 8px;text-align:left;border:1px solid var(--line);border-radius:9px;background:#f8fafb}.camera-tabs button.active{color:#1f5fcf;border-color:#8fb1f4;background:#eaf1ff}.camera-tabs button:disabled{opacity:.48}.camera-tabs span,.camera-tabs small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.camera-tabs span{font-size:10px;font-weight:700}.camera-tabs small{margin-top:4px;color:#788896;font-size:8px}
        .auto-pipeline{min-height:92px;padding:12px 17px;display:grid;grid-template-columns:1fr 1fr 1.15fr 1fr;align-items:center;gap:12px}.pipeline-title,.pipeline-model{display:flex;align-items:center;gap:9px}.pipeline-title>svg,.pipeline-model>svg{color:var(--blue)}.pipeline-title span,.pipeline-model span{display:flex;flex-direction:column;gap:4px}.pipeline-title strong,.pipeline-model strong{font-size:10px}.pipeline-title small,.pipeline-model small{color:var(--muted);font-size:8px}.pipeline-model{position:relative;padding:10px;border:1px solid var(--line);border-radius:9px}.pipeline-model>i{width:6px;height:6px;margin-left:auto;border-radius:50%;background:#b8c1c7}.pipeline-model>i.ready{background:#2aa66f}.pipeline-progress{display:grid;grid-template-columns:1fr auto;gap:5px;color:#687987;font-size:8px}.pipeline-progress strong{color:var(--ink)}.pipeline-progress>div{grid-column:1/3;height:4px;overflow:hidden;background:#e7edf1;border-radius:5px}.pipeline-progress>div i{display:block;height:100%;background:var(--blue);transition:width .35s}
        .alert-count{min-width:27px;height:27px;display:grid;place-items:center;color:#ad4f50;background:#fff0f0;border-radius:50%;font-size:10px;font-weight:700}.alert-list{height:560px;padding:14px;display:flex;flex-direction:column;gap:11px;overflow-y:auto;background:#f8fafb;scrollbar-width:thin!important}.alert-item{padding:15px;border:1px solid #e2e7eb;border-left:3px solid #d69a47;border-radius:10px;background:#fff}.alert-item.critical{border-left-color:#d86060}.alert-item.high{border-left-color:#dc8751}.alert-topline,.alert-actions{display:flex;align-items:center;justify-content:space-between}.severity{padding:5px 7px;color:#8a641f;background:#fff4dd;border-radius:5px;font-size:8px;font-style:normal;font-weight:700}.severity.high{color:#a85525;background:#fff0e7}.severity.critical{color:#a84445;background:#fdeaea}.alert-topline small{color:#7c8a96;font-size:8px}.alert-item h2{margin-top:13px;font-size:13px}.alert-item>p{margin-top:6px;color:var(--muted);font-size:9px}.alert-actions{margin-top:14px;padding-top:12px;border-top:1px solid #edf0f2}.alert-actions button{padding:8px 10px;color:#fff;background:var(--blue);border-radius:6px;font-size:8px;font-weight:700}.alert-actions span{color:#a06a28;font-size:8px}.scanning-empty{min-height:400px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#687a88;text-align:center}.scanning-empty>span{width:50px;height:50px;display:grid;place-items:center;color:var(--blue);background:#eaf1ff;border-radius:50%}.scanning-empty strong{margin-top:13px;font-size:11px}.scanning-empty small{max-width:220px;margin-top:6px;line-height:1.5;font-size:9px}.alerts-footer{height:51px;padding:0 18px;display:flex;align-items:center;gap:8px;color:#5d7468;border-top:1px solid var(--line);font-size:9px}.alerts-footer i{width:6px;height:6px;margin-left:auto;border-radius:50%;background:#2aa66f}
        .history-section{margin-top:34px}.history-tabs{height:58px;padding:0 20px;display:flex;align-items:end;gap:28px;border-bottom:1px solid var(--line)}.history-tabs button{height:58px;position:relative;color:#627484;font-size:12px;font-weight:600}.history-tabs button.active{color:var(--ink)}.history-tabs button.active:after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--blue)}.history-tabs button span{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-left:6px;color:#fff;background:var(--blue);border-radius:10px;font-size:8px}.history-workspace{display:grid;grid-template-columns:minmax(330px,.78fr) minmax(0,1.22fr);min-height:570px}.history-list{padding:12px;background:#f8fafb;border-right:1px solid var(--line);max-height:650px;overflow-y:auto;scrollbar-width:thin!important}.history-list button{width:100%;min-height:75px;padding:12px 11px;display:grid;grid-template-columns:6px auto 1fr auto;align-items:center;gap:9px;text-align:left;border-bottom:1px solid #e5eaed}.history-list button.active{background:#fff;border:1px solid #cfdce5;border-radius:9px}.history-list button>i{width:6px;height:6px;border-radius:50%;background:#e35f5f}.history-list button>span:nth-child(3){display:flex;min-width:0;flex-direction:column;gap:5px}.history-list button strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.history-list button small{color:#71818e;font-size:8px}.history-list button em{color:#9a671f;font-size:8px;font-style:normal}.history-detail{padding:24px 27px}.detail-heading{display:flex;justify-content:space-between;gap:20px}.detail-heading h2{margin-top:10px;font-size:20px}.detail-heading p{margin-top:5px;color:var(--muted);font-size:9px}.detail-heading>span{color:#9a671f;font-size:9px}.detail-meta{margin-top:20px;padding:13px 0;display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:#536472;font-size:9px}.detail-meta span{display:flex;flex-direction:column;gap:4px}.detail-meta small{color:#8b99a4;font-size:7px}.detail-description{margin-top:17px;color:#596a77;font-size:10px;line-height:1.7}.evidence{margin-top:18px}.evidence>span{display:flex;align-items:center;gap:6px;margin-bottom:9px;color:#6c7b87;font-size:8px;font-weight:700}.evidence-media{position:relative;min-height:260px;display:grid;place-items:center;overflow:hidden;border-radius:10px;background:#10191e}.evidence img,.evidence video{width:100%;max-height:315px;display:block;object-fit:contain;background:#10191e}.evidence-roi{z-index:3}.review-actions{margin-top:17px;display:flex;gap:10px}.review-actions button{height:39px;padding:0 14px;display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:7px;color:#546674;font-size:9px}.review-actions button:first-child{color:#fff;background:var(--blue);border-color:var(--blue)}
        .empty-history{min-height:390px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#70818e}.empty-history strong{margin-top:12px;font-size:12px}.empty-history span{margin-top:6px;font-size:9px}.stats-view{padding:22px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stats-view>div{min-height:105px;padding:18px;display:flex;flex-direction:column;justify-content:space-between;border:1px solid var(--line);border-radius:10px;background:#f9fbfc}.stats-view small{color:var(--muted);font-size:9px}.stats-view strong{font-size:27px}.stats-view article{grid-column:1/5;padding:19px;border:1px solid var(--line);border-radius:10px}.stats-view h3{font-size:12px}.stats-view p{margin-top:12px;display:flex;justify-content:space-between;color:#647481;font-size:10px}.system-note{margin-top:22px;padding:17px 20px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:10px}.system-note>svg{color:var(--blue)}.system-note div{display:flex;flex-direction:column;gap:4px}.system-note strong{font-size:10px}.system-note small{color:var(--muted);font-size:8px}.system-note>span{color:#2b8e66;font-size:8px;font-weight:700}.monitor-footer{min-height:90px;display:flex;align-items:center;justify-content:space-between;color:#80909c;font-size:9px}.alert-toast{position:fixed;right:24px;top:88px;z-index:50;width:min(360px,calc(100% - 32px));padding:14px;display:flex;align-items:center;gap:11px;text-align:left;color:var(--ink);border:1px solid #efcaca;border-left:4px solid #d86060;border-radius:11px;background:#fff;box-shadow:0 18px 55px rgba(31,46,58,.18);animation:toast-in .3s ease}.alert-toast>span{width:38px;height:38px;display:grid;place-items:center;color:#c95050;background:#fdeaea;border-radius:8px}.alert-toast div{display:flex;flex-direction:column;gap:4px}.alert-toast small{color:#9b6363;font-size:7px}.alert-toast strong{font-size:11px}.roi-evidence-crop{position:relative;width:100%;max-height:380px;overflow:hidden;background:#10191e}.roi-evidence-crop img{position:absolute!important;height:auto!important;max-height:none!important;max-width:none!important;object-fit:initial!important}.evidence-media.cropped{min-height:0}@keyframes toast-in{from{transform:translateY(-12px);opacity:0}}.spin{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
        .monitor-brand small{font-size:12px}.monitor-header-actions>button,.monitor-header-actions>a,.monitor-header-actions>span{font-size:12px}.monitor-kicker{font-size:11px}.monitor-summary small{font-size:11px}.panel-heading strong{font-size:15px}.panel-heading small{font-size:11px}.camera-id{font-size:12px}.camera-placeholder{font-size:14px}.camera-live,.camera-ai{font-size:10px}.camera-caption{font-size:12px}.violation-roi>span{font-size:10px}.camera-tabs span{font-size:12px}.camera-tabs small{font-size:10px}.pipeline-title strong,.pipeline-model strong{font-size:12px}.pipeline-title small,.pipeline-model small{font-size:10px}.pipeline-progress{font-size:10px}.alert-count{font-size:12px}.severity{font-size:10px}.alert-topline small{font-size:10px}.alert-item h2{font-size:15px}.alert-item>p{font-size:11px}.alert-actions button,.alert-actions span{font-size:10px}.scanning-empty strong{font-size:13px}.scanning-empty small,.alerts-footer{font-size:11px}.history-tabs button{font-size:14px}.history-tabs button span{font-size:10px}.history-list button strong{font-size:12px}.history-list button small{font-size:11px}.history-list button em{font-size:10px}.detail-heading p,.detail-heading>span{font-size:11px}.detail-meta{font-size:11px}.detail-meta small{font-size:10px}.detail-description{font-size:13px}.evidence>span{font-size:11px}.review-actions button{font-size:11px}.empty-history strong{font-size:14px}.empty-history span,.stats-view small{font-size:11px}.stats-view h3{font-size:14px}.stats-view p{font-size:12px}.system-note strong{font-size:12px}.system-note small,.system-note>span{font-size:10px}.monitor-footer{font-size:11px}.alert-toast small{font-size:10px}.alert-toast strong{font-size:13px}
        .demo-sync-warning{margin:18px 0 0;padding:12px 15px;display:flex;align-items:center;gap:10px;border:1px solid #e9c981;border-radius:10px;background:#fff8e7;color:#7a5620;font-size:12px;line-height:1.45}.demo-sync-warning span{flex:1}.demo-sync-warning a{color:#1f5fcf;font-weight:700;text-decoration:none;white-space:nowrap}.demo-alert-unsynced{display:inline-block;margin-top:8px;color:#9a671f;font-size:11px;font-weight:700}.evidence-original{display:table;margin:0 0 12px auto;color:#245fcb;font-size:12px;font-weight:700;text-decoration:none}.evidence-original:hover,.demo-sync-warning a:hover{text-decoration:underline}.evidence-media:not(.cropped)>img{width:auto;height:auto;max-width:100%;max-height:360px;object-fit:contain}.roi-evidence-crop img{image-rendering:auto}
        .pipeline-progress small{grid-column:1/3;color:#71818e;font-size:9px;line-height:1.3}.evidence-media{height:clamp(280px,48vw,430px);min-height:0}.evidence-media>img{width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important}.evidence-context{display:table;margin:9px 0 0 auto;color:#245fcb;font-size:12px;font-weight:700;text-decoration:none}.evidence-context:hover{text-decoration:underline}
        @media(max-width:1120px){.monitor-grid{grid-template-columns:1.35fr .75fr}.auto-pipeline{grid-template-columns:1fr 1fr}.pipeline-title{display:none}.history-workspace{grid-template-columns:1fr}.history-list{max-height:330px;border-right:0;border-bottom:1px solid var(--line)}}
        @media(max-width:820px){.monitor-shell{width:min(100% - 28px,720px)}.monitor-titlebar{align-items:flex-start;flex-direction:column}.monitor-summary{width:100%}.monitor-summary>span{min-width:0;flex:1}.monitor-grid{grid-template-columns:1fr}.alert-list{height:auto;min-height:260px}.stats-view{grid-template-columns:repeat(2,1fr)}.stats-view article{grid-column:1/3}}
        @media(max-width:580px){.monitor-header{height:64px;padding:0 15px}.monitor-header-actions>span,.monitor-header-actions>button{display:none}.monitor-header-actions a{font-size:0}.monitor-titlebar{padding-top:27px}.monitor-titlebar h1{font-size:26px}.monitor-summary>span{padding:9px;grid-template-columns:17px 1fr}.camera-stage{aspect-ratio:16/10}.camera-caption{display:none}.camera-tabs{grid-template-columns:repeat(5,minmax(52px,1fr));overflow-x:auto}.camera-tabs button{text-align:center}.camera-tabs small{font-size:6px}.auto-pipeline{grid-template-columns:1fr}.pipeline-title{display:flex}.pipeline-progress{padding:7px}.history-tabs{padding:0 14px}.history-workspace{min-height:0}.history-list{max-height:360px}.history-list button{grid-template-columns:6px 1fr auto}.history-list .severity{display:none}.history-detail{padding:19px 15px}.detail-meta{gap:10px}.review-actions{flex-direction:column}.review-actions button{justify-content:center}.stats-view{padding:14px}.monitor-footer{flex-direction:column;align-items:flex-start;justify-content:center;gap:6px}.alert-toast{right:16px;top:75px}.system-note{grid-template-columns:20px 1fr}.system-note>span{display:none}}
        @media(prefers-reduced-motion:reduce){.monitoring-demo *{animation:none!important;transition:none!important}}
      `}</style>
    </main>
  );
}

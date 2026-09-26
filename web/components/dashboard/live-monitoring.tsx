'use client';

import {
  Activity,
  BellRing,
  Camera,
  Check,
  ChevronDown,
  CircleDot,
  Download,
  Expand,
  Eye,
  EyeOff,
  Filter,
  Grid2X2,
  Grid3X3,
  HardHat,
  LoaderCircle,
  MapPin,
  Maximize2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ScanLine,
  Search,
  ShieldAlert,
  Sparkles,
  Video,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readAuthSession } from '@/lib/auth';
import styles from './live-monitoring.module.css';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

type VideoItem = {
  id: number;
  filename: string;
  labels: string[];
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  stream_url: string;
};

type ModelItem = {
  name: string;
  type: 'detection' | 'classification';
  version: string;
  connected: boolean;
  loaded: boolean;
  status: string;
};

type InferenceResult = {
  video_id: number;
  model: string;
  prediction: string;
  confidence: number;
  output_video: string;
  processing_time: number;
  metrics: Record<string, unknown>;
  event_ids: string[];
  violations_saved: number;
};

type CameraItem = {
  id: string;
  name: string;
  zone: string;
  site: string;
  video: VideoItem;
};

type Detection = {
  id: string;
  cameraId: string;
  title: string;
  model: string;
  confidence: number | null;
  time: string;
  severity: 'critical' | 'high' | 'medium' | 'safe';
};

type EvidenceEvent = {
  class_name?: string;
  track_id?: number | null;
  timestamp_seconds?: number;
  confidence?: number | null;
  person_confidence?: number | null;
};

const CAMERA_META = [
  ['CAM-01', 'Toàn cảnh xưởng', 'Lối đi sản xuất'],
  ['CAM-02', 'Khu vực xe nâng', 'Bãi trung chuyển'],
  ['CAM-03', 'Tủ điện máy ép', 'Khu kỹ thuật'],
  ['CAM-04', 'Máy gia công', 'Khu vực hạn chế'],
  ['CAM-05', 'Lối đi chính', 'Giao cắt nội bộ'],
  ['CAM-06', 'Kho nguyên liệu', 'Cửa nhập hàng'],
  ['CAM-07', 'Dây chuyền đóng gói', 'Khu sản xuất B'],
  ['CAM-08', 'Cổng nhà máy', 'Khu vực kiểm soát'],
  ['CAM-09', 'Khu bảo trì', 'Xưởng cơ khí'],
] as const;

const LABELS_VI: Record<string, string> = {
  'Safe Walkway Violation': 'Đi vào khu vực nguy hiểm',
  'Unauthorized Intervention': 'Can thiệp trái phép',
  'Opened Panel Cover': 'Nắp tủ điện đang mở',
  'Carrying Overload with Forklift': 'Xe nâng chở quá tải',
  'Suspected no helmet': 'Nghi ngờ không đội mũ bảo hộ',
  'Suspected no vest': 'Nghi ngờ không mặc áo bảo hộ',
  'Authorized Intervention': 'Can thiệp được cấp phép',
  'Closed Panel Cover': 'Nắp tủ điện đã đóng',
  'Safe Carrying': 'Vận chuyển an toàn',
  'Safe Walkway': 'Di chuyển đúng lối đi',
};

function authHeaders(json = false): HeadersInit {
  const session = readAuthSession();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(session ? { Authorization: 'Bearer ' + session.session.access_token } : {}),
  };
}

function translateLabel(label: string): string {
  return LABELS_VI[label] || label.replaceAll('_', ' ');
}

function severityFor(label: string): Detection['severity'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('unauthorized') || normalized.includes('helmet')) return 'critical';
  if (normalized.includes('overload') || normalized.includes('opened') || normalized.includes('vest')) return 'high';
  if (normalized.includes('violation')) return 'medium';
  return 'safe';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  return String(minutes).padStart(2, '0') + ':' + String(Math.round(seconds % 60)).padStart(2, '0');
}

function getErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      return String((detail as { message: unknown }).message);
    }
  }
  return 'Không thể hoàn thành yêu cầu.';
}

export default function LiveMonitoring() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [selectedId, setSelectedId] = useState('CAM-01');
  const [layout, setLayout] = useState<1 | 4 | 9>(4);
  const [search, setSearch] = useState('');
  const [zone, setZone] = useState('Tất cả khu vực');
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [streamUrls, setStreamUrls] = useState<Record<number, string>>({});
  const [streamErrors, setStreamErrors] = useState<Record<number, string>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState('');
  const [detections, setDetections] = useState<Detection[]>([]);
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [toast, setToast] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({});
  const objectUrls = useRef<Record<number, string>>({});

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setConnectionError('');
    try {
      const [videoResponse, modelResponse] = await Promise.all([
        fetch(API_BASE + '/api/videos/test', { headers: authHeaders() }),
        fetch(API_BASE + '/api/models', { headers: authHeaders() }),
      ]);
      if (!videoResponse.ok) {
        const payload = await videoResponse.json().catch(() => null);
        throw new Error(getErrorMessage(payload));
      }
      const videoCatalog = await videoResponse.json() as VideoItem[];
      setVideos(videoCatalog);
      if (modelResponse.ok) setModels(await modelResponse.json() as ModelItem[]);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Không thể kết nối backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      Object.values(urls).forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const cameras = useMemo<CameraItem[]>(() => {
    return CAMERA_META.flatMap((meta, index): CameraItem[] => {
      const video = videos[index];
      return video ? [{
        id: meta[0],
        name: meta[1],
        zone: meta[2],
        site: 'Nhà máy chính',
        video,
      }] : [];
    });
  }, [videos]);

  const zones = useMemo(
    () => ['Tất cả khu vực', ...Array.from(new Set(cameras.map(camera => camera.zone)))],
    [cameras],
  );

  const filteredCameras = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('vi');
    return cameras.filter(camera => {
      const inZone = zone === 'Tất cả khu vực' || camera.zone === zone;
      const inSearch = !query || [camera.id, camera.name, camera.zone]
        .some(value => value.toLocaleLowerCase('vi').includes(query));
      return inZone && inSearch;
    });
  }, [cameras, search, zone]);

  const selectedCamera = cameras.find(camera => camera.id === selectedId) || cameras[0];
  const visibleCameras = useMemo(() => {
    if (!filteredCameras.length) return [];
    const selectedIndex = filteredCameras.findIndex(camera => camera.id === selectedId);
    const start = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / layout) * layout;
    return filteredCameras.slice(start, start + layout);
  }, [filteredCameras, layout, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    const missing = visibleCameras.filter(camera => !objectUrls.current[camera.video.id]);
    if (!missing.length) return () => controller.abort();

    void Promise.all(missing.map(async camera => {
      try {
        const response = await fetch(API_BASE + camera.video.stream_url, {
          headers: authHeaders(),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const blobUrl = URL.createObjectURL(await response.blob());
        if (controller.signal.aborted) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        objectUrls.current[camera.video.id] = blobUrl;
        setStreamUrls(current => ({ ...current, [camera.video.id]: blobUrl }));
      } catch (error) {
        if (!controller.signal.aborted) {
          setStreamErrors(current => ({
            ...current,
            [camera.video.id]: error instanceof Error ? error.message : 'Lỗi tải luồng',
          }));
        }
      }
    }));
    return () => controller.abort();
  }, [visibleCameras]);

  useEffect(() => {
    Object.values(videoRefs.current).forEach(video => {
      if (!video) return;
      video.muted = muted;
      if (playing) void video.play().catch(() => undefined);
      else video.pause();
    });
  }, [muted, playing, streamUrls]);

  const selectCamera = (camera: CameraItem) => {
    setSelectedId(camera.id);
    setResult(null);
    if (layout === 1) setPlaying(true);
  };

  const toggleFullscreen = async () => {
    if (!gridRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await gridRef.current.requestFullscreen();
  };

  const captureSnapshot = () => {
    if (!selectedCamera) return;
    const video = videoRefs.current[selectedCamera.video.id];
    if (!video || !video.videoWidth) {
      setToast('Camera chưa sẵn sàng để chụp ảnh.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const link = document.createElement('a');
    link.download = selectedCamera.id + '-' + new Date().toISOString().replaceAll(':', '-') + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    setToast('Đã lưu ảnh chụp từ ' + selectedCamera.id);
  };

  const runAnalysis = async () => {
    if (!selectedCamera || analyzing) return;
    const connected = models.filter(model => model.connected);
    if (!connected.length) {
      setToast('Chưa có mô hình AI nào được kết nối.');
      return;
    }
    setAnalyzing(true);
    setResult(null);
    try {
      const newDetections: Detection[] = [];
      let totalSaved = 0;
      for (const model of connected) {
        setAnalysisProgress('Đang chạy ' + model.name + '...');
        const response = await fetch(API_BASE + '/api/inference', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({
            video_id: selectedCamera.video.id,
            model_name: model.name,
            camera_code: selectedCamera.id,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(getErrorMessage(payload));
        const inference = payload as InferenceResult;
        setResult(inference);
        totalSaved += inference.violations_saved || 0;
        const evidence = Array.isArray(inference.metrics.evidence_events)
          ? inference.metrics.evidence_events as EvidenceEvent[]
          : [];
        if (model.name === 'RF-DETR' && evidence.length) {
          evidence.forEach((event, index) => {
            const label = event.class_name || inference.prediction;
            const confidence = event.confidence ?? event.person_confidence ?? null;
            newDetections.push({
              id: selectedCamera.id + '-' + model.name + '-' + Date.now() + '-' + index,
              cameraId: selectedCamera.id,
              title: translateLabel(label) + (event.track_id ? ' · Người #' + event.track_id : ''),
              model: model.name,
              confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null,
              time: new Date().toLocaleTimeString('vi-VN'),
              severity: severityFor(label),
            });
          });
        } else {
          const severity = severityFor(inference.prediction);
          newDetections.push({
            id: selectedCamera.id + '-' + model.name + '-' + Date.now(),
            cameraId: selectedCamera.id,
            title: translateLabel(inference.prediction),
            model: model.name,
            confidence: Number.isFinite(inference.confidence) ? inference.confidence : null,
            time: new Date().toLocaleTimeString('vi-VN'),
            severity,
          });
        }
      }
      setDetections(current => [...newDetections.reverse(), ...current].slice(0, 30));
      setToast(
        totalSaved > 0
          ? 'Đã lưu ' + totalSaved + ' vi phạm của ' + selectedCamera.id + ' vào Cảnh báo.'
          : 'Đã hoàn tất phân tích ' + selectedCamera.id + ', không có vi phạm mới.',
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Phân tích AI thất bại.');
    } finally {
      setAnalyzing(false);
      setAnalysisProgress('');
    }
  };

  const openIncidentDraft = () => {
    if (!result || !selectedCamera) {
      setToast('Hãy phân tích camera và chọn một kết quả trước.');
      return;
    }
    setToast('Đã chuẩn bị dữ liệu sự cố. API tạo sự cố sẽ được kết nối ở module Sự cố.');
  };

  const criticalCount = detections.filter(item => item.severity === 'critical' || item.severity === 'high').length;
  const connectedModels = models.filter(model => model.connected).length;

  return (
    <div className={styles.page}>
      {toast && (
        <button className={styles.toast} type="button" onClick={() => setToast('')}>
          <Check size={16} /><span>{toast}</span><X size={14} />
        </button>
      )}

      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}><Radio size={13} /> TRUNG TÂM ĐIỀU HÀNH TRỰC TIẾP</span>
          <h1>Giám sát camera</h1>
          <p>Theo dõi nhiều khu vực, điều khiển luồng phát và phân tích video bằng mô hình AI đã kết nối.</p>
        </div>
        <div className={styles.headingStatus}>
          <span data-online={!connectionError}><i />{connectionError ? 'Mất kết nối' : 'Hệ thống trực tuyến'}</span>
          <button type="button" onClick={() => void loadCatalog()} disabled={loading}>
            <RefreshCw size={15} className={loading ? styles.spinning : undefined} /> Làm mới
          </button>
        </div>
      </header>

      <section className={styles.metrics}>
        <article><span className={styles.blue}><Camera size={18} /></span><div><strong>{cameras.length}</strong><small>Camera khả dụng</small></div><em>{cameras.length ? 'Đang kết nối' : 'Chưa có dữ liệu'}</em></article>
        <article><span className={styles.green}><Wifi size={18} /></span><div><strong>{visibleCameras.length}</strong><small>Luồng đang hiển thị</small></div><em>Bố cục {layout} ô</em></article>
        <article><span className={styles.violet}><Sparkles size={18} /></span><div><strong>{connectedModels}/{models.length || 2}</strong><small>Mô hình AI</small></div><em>{connectedModels ? 'Sẵn sàng phân tích' : 'Chưa kết nối'}</em></article>
        <article><span className={styles.red}><ShieldAlert size={18} /></span><div><strong>{criticalCount}</strong><small>Phát hiện rủi ro</small></div><em>Trong phiên hiện tại</em></article>
      </section>

      <section className={styles.toolbar}>
        <div className={styles.filters}>
          <label className={styles.search}><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm mã, tên camera..." /></label>
          <label className={styles.select}><Filter size={14} /><select value={zone} onChange={event => setZone(event.target.value)}>{zones.map(item => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></label>
        </div>
        <div className={styles.viewControls}>
          <span>Bố cục</span>
          <button className={layout === 1 ? styles.active : undefined} type="button" onClick={() => setLayout(1)} title="Một camera"><Maximize2 size={15} /></button>
          <button className={layout === 4 ? styles.active : undefined} type="button" onClick={() => setLayout(4)} title="Bốn camera"><Grid2X2 size={15} /></button>
          <button className={layout === 9 ? styles.active : undefined} type="button" onClick={() => setLayout(9)} title="Chín camera"><Grid3X3 size={15} /></button>
          <i />
          <button className={showOverlay ? styles.active : undefined} type="button" onClick={() => setShowOverlay(value => !value)} title="Bật/tắt lớp AI">{showOverlay ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          <button type="button" onClick={() => void toggleFullscreen()} title="Toàn màn hình"><Expand size={15} /></button>
        </div>
      </section>

      {connectionError ? (
        <section className={styles.errorState}>
          <span><WifiOff size={25} /></span>
          <strong>Không thể tải hệ thống camera</strong>
          <p>{connectionError}</p>
          <button type="button" onClick={() => void loadCatalog()}><RefreshCw size={14} /> Thử kết nối lại</button>
        </section>
      ) : (
        <div className={panelOpen ? styles.workspace : styles.workspaceWide}>
          <div className={styles.monitorColumn}>
            <div
              ref={gridRef}
              className={styles.cameraGrid}
              data-layout={layout}
            >
              {loading && !visibleCameras.length ? (
                <div className={styles.gridLoading}><LoaderCircle className={styles.spinning} size={24} /><span>Đang thiết lập các luồng camera...</span></div>
              ) : visibleCameras.length ? visibleCameras.map(camera => {
                const selected = camera.id === selectedId;
                const source = streamUrls[camera.video.id];
                const cameraDetections = detections.filter(item => item.cameraId === camera.id);
                return (
                  <article
                    key={camera.id}
                    className={selected ? styles.cameraTile + ' ' + styles.selectedTile : styles.cameraTile}
                    onClick={() => selectCamera(camera)}
                  >
                    {source ? (
                      <video
                        ref={node => { videoRefs.current[camera.video.id] = node; }}
                        src={source}
                        autoPlay
                        muted={muted}
                        loop
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <div className={styles.streamPlaceholder}>
                        {streamErrors[camera.video.id] ? <WifiOff size={21} /> : <LoaderCircle className={styles.spinning} size={21} />}
                        <span>{streamErrors[camera.video.id] || 'Đang tải luồng bảo mật'}</span>
                      </div>
                    )}
                    <div className={styles.tileTop}>
                      <span className={styles.live}><i /> LIVE</span>
                      <span className={styles.cameraCode}>{camera.id}</span>
                    </div>
                    {showOverlay && cameraDetections[0] && (
                      <div className={styles.aiOverlay} data-severity={cameraDetections[0].severity}>
                        <span><ScanLine size={12} /> {cameraDetections[0].title}</span>
                        {cameraDetections[0].confidence !== null && <em>{Math.round(cameraDetections[0].confidence * 100)}%</em>}
                      </div>
                    )}
                    <div className={styles.tileBottom}>
                      <div><strong>{camera.name}</strong><span><MapPin size={10} /> {camera.zone}</span></div>
                      <span><Wifi size={12} /> {camera.video.width || '—'}p</span>
                    </div>
                  </article>
                );
              }) : (
                <div className={styles.gridLoading}><Camera size={24} /><span>Không có camera phù hợp bộ lọc.</span></div>
              )}
            </div>

            <div className={styles.playerControls}>
              <div>
                <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
                <button type="button" onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
                <span><CircleDot size={12} /> {selectedCamera?.id || '—'} · {selectedCamera?.name || 'Chưa chọn camera'}</span>
              </div>
              <div>
                <button type="button" onClick={captureSnapshot} disabled={!selectedCamera}><Download size={15} /> Chụp ảnh</button>
                <button className={styles.aiButton} type="button" onClick={() => void runAnalysis()} disabled={!selectedCamera || analyzing}>
                  {analyzing ? <LoaderCircle className={styles.spinning} size={15} /> : <Sparkles size={15} />}
                  {analyzing ? analysisProgress : 'Phân tích AI'}
                </button>
                <button type="button" onClick={() => setPanelOpen(value => !value)}>{panelOpen ? <X size={15} /> : <BellRing size={15} />}</button>
              </div>
            </div>

            <section className={styles.cameraDirectory}>
              <div className={styles.sectionHeading}><div><strong>Danh sách camera</strong><span>{filteredCameras.length} camera phù hợp</span></div><span><Activity size={13} /> Cập nhật theo phiên</span></div>
              <div className={styles.cameraRows}>
                {filteredCameras.map(camera => (
                  <button key={camera.id} type="button" className={camera.id === selectedId ? styles.activeRow : undefined} onClick={() => selectCamera(camera)}>
                    <span className={styles.cameraThumb}><Video size={16} /></span>
                    <span><strong>{camera.id} · {camera.name}</strong><small>{camera.site} / {camera.zone}</small></span>
                    <em><i /> Trực tuyến</em>
                    <small>{formatDuration(camera.video.duration)}</small>
                  </button>
                ))}
              </div>
            </section>
          </div>

          {panelOpen && (
            <aside className={styles.sidePanel}>
              <div className={styles.sideHeading}>
                <div><strong>Trung tâm AI</strong><span>Kết quả phân tích trong phiên</span></div>
                <span className={styles.alertBadge}>{detections.length}</span>
              </div>

              <div className={styles.modelStatus}>
                {models.length ? models.map(model => (
                  <div key={model.name}>
                    <span className={model.name === 'RF-DETR' ? styles.modelBlue : styles.modelViolet}>
                      {model.name === 'RF-DETR' ? <HardHat size={16} /> : <ScanLine size={16} />}
                    </span>
                    <div><strong>{model.name}</strong><small>{model.type} · {model.version || 'chưa có phiên bản'}</small></div>
                    <em data-online={model.connected}><i />{model.connected ? model.loaded ? 'Đã nạp' : 'Sẵn sàng' : 'Ngoại tuyến'}</em>
                  </div>
                )) : (
                  <div className={styles.modelEmpty}><Sparkles size={16} /><span>Chưa nhận được catalog mô hình</span></div>
                )}
              </div>

              <div className={styles.detectionHeading}>
                <div><strong>Phát hiện gần đây</strong><span>Chỉ hiển thị kết quả AI thật</span></div>
                <button type="button" onClick={() => setDetections([])} disabled={!detections.length}>Xóa</button>
              </div>

              <div className={styles.detectionList}>
                {detections.length ? detections.map(item => (
                  <button key={item.id} type="button" data-severity={item.severity} onClick={() => setSelectedId(item.cameraId)}>
                    <span><ShieldAlert size={15} /></span>
                    <div><strong>{item.title}</strong><small>{item.cameraId} · {item.model} · {item.time}</small></div>
                    <em>{item.confidence === null ? '—' : Math.round(item.confidence * 100) + '%'}</em>
                  </button>
                )) : (
                  <div className={styles.emptyDetections}>
                    <span><Eye size={22} /></span>
                    <strong>Chưa có kết quả phân tích</strong>
                    <p>Chọn một camera rồi nhấn “Phân tích AI”. Hệ thống không tạo cảnh báo giả trước khi mô hình trả kết quả.</p>
                  </div>
                )}
              </div>

              <div className={styles.resultCard}>
                <div><strong>Camera đang chọn</strong><span>{selectedCamera?.id || '—'}</span></div>
                <dl>
                  <div><dt>Vị trí</dt><dd>{selectedCamera?.zone || '—'}</dd></div>
                  <div><dt>Nguồn</dt><dd>{selectedCamera?.video.filename || '—'}</dd></div>
                  <div><dt>Độ phân giải</dt><dd>{selectedCamera?.video.width && selectedCamera.video.height ? selectedCamera.video.width + ' × ' + selectedCamera.video.height : '—'}</dd></div>
                  <div><dt>FPS</dt><dd>{selectedCamera?.video.fps ? Math.round(selectedCamera.video.fps) : '—'}</dd></div>
                </dl>
                {result && <p><Sparkles size={13} /> Kết quả cuối: <strong>{translateLabel(result.prediction)}</strong></p>}
                <button type="button" onClick={openIncidentDraft} disabled={!result}><ShieldAlert size={14} /> Tạo phiếu sự cố</button>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

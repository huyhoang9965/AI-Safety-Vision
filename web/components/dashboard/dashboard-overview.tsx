'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  FileWarning,
  MapPin,
  Play,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  Siren,
  Wifi,
} from 'lucide-react';
import { readAuthSession } from '@/lib/auth';
import styles from './overview.module.css';

type HealthPayload = {
  status: string;
  database: string;
  test_videos: number;
  loaded_models: string[];
};

type ModelPayload = {
  name: string;
  type: string;
  version: string;
  connected: boolean;
  loaded: boolean;
  status: string;
};

const cameras = [
  { code: 'CAM-01', location: 'Toàn cảnh xưởng', zone: 'Lối đi sản xuất' },
  { code: 'CAM-02', location: 'Khu vực xe nâng', zone: 'Bãi trung chuyển' },
  { code: 'CAM-03', location: 'Tủ điện máy ép', zone: 'Khu kỹ thuật' },
  { code: 'CAM-04', location: 'Máy gia công', zone: 'Khu vực hạn chế' },
  { code: 'CAM-05', location: 'Lối đi chính', zone: 'Giao cắt nội bộ' },
];

export default function DashboardOverview() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [models, setModels] = useState<ModelPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadSystemStatus = useCallback(async () => {
    setLoading(true);
    const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
    const stored = readAuthSession();
    const headers = stored
      ? { Authorization: 'Bearer ' + stored.session.access_token }
      : undefined;
    try {
      const [healthResponse, modelsResponse] = await Promise.all([
        fetch(base + '/api/health'),
        fetch(base + '/api/models', { headers }),
      ]);
      if (!healthResponse.ok || !modelsResponse.ok) throw new Error('Backend unavailable');
      setHealth(await healthResponse.json() as HealthPayload);
      setModels(await modelsResponse.json() as ModelPayload[]);
      setLastUpdated(new Date());
    } catch {
      setHealth(null);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSystemStatus();
  }, [loadSystemStatus]);

  const systemOnline = health?.database === 'connected';
  const connectedModels = models.filter(model => model.connected).length;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}>
        <div>
          <span className={styles.eyebrow}>TRUNG TÂM ĐIỀU HÀNH AN TOÀN</span>
          <h1>Tổng quan hệ thống</h1>
          <p>Theo dõi camera, AI pipeline, cảnh báo và trạng thái vận hành trên một không gian thống nhất.</p>
        </div>
        <div className={styles.headingActions}>
          <button onClick={() => void loadSystemStatus()} disabled={loading}>
            <RefreshCw size={15} className={loading ? styles.spinning : undefined} />
            Làm mới
          </button>
          <Link href="/dashboard/live"><Play size={15} /> Mở giám sát trực tiếp</Link>
        </div>
      </div>

      <div className={styles.statusStrip}>
        <span className={systemOnline ? styles.statusOnline : styles.statusOffline}>
          <i /> {systemOnline ? 'Hệ thống đang hoạt động' : 'Backend chưa kết nối'}
        </span>
        <span><Clock3 size={13} /> {lastUpdated ? 'Cập nhật lúc ' + lastUpdated.toLocaleTimeString('vi-VN') : 'Chưa có dữ liệu thời gian thực'}</span>
        <span><Database size={13} /> PostgreSQL: {health?.database || 'unknown'}</span>
      </div>

      <section className={styles.kpiGrid} aria-label="Chỉ số tổng quan">
        <article className={styles.kpiCard}>
          <div className={styles.kpiTop}><span className={styles.blueIcon}><Camera size={18} /></span><em>Đã cấu hình</em></div>
          <strong>05</strong>
          <p>Camera giám sát</p>
          <small><Wifi size={12} /> Nguồn demo hiện tại</small>
        </article>
        <article className={styles.kpiCard}>
          <div className={styles.kpiTop}><span className={styles.orangeIcon}><Siren size={18} /></span><em>Chờ API sự kiện</em></div>
          <strong>—</strong>
          <p>Vi phạm hôm nay</p>
          <small><ShieldAlert size={12} /> Sẽ lấy từ safety_events</small>
        </article>
        <article className={styles.kpiCard}>
          <div className={styles.kpiTop}><span className={styles.redIcon}><FileWarning size={18} /></span><em>Chờ API sự cố</em></div>
          <strong>—</strong>
          <p>Sự cố đang mở</p>
          <small><Activity size={12} /> Sẽ lấy từ incidents</small>
        </article>
        <article className={styles.kpiCard}>
          <div className={styles.kpiTop}><span className={styles.greenIcon}><Server size={18} /></span><em>{systemOnline ? 'Sẵn sàng' : 'Cần kiểm tra'}</em></div>
          <strong>{connectedModels}/{models.length || 2}</strong>
          <p>Mô hình AI kết nối</p>
          <small><Bot size={12} /> RF-DETR · VideoMAE</small>
        </article>
      </section>

      <div className={styles.primaryGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div><strong>Hệ thống camera</strong><span>5 vị trí giám sát đã định nghĩa</span></div>
            <Link href="/dashboard/cameras">Quản lý camera <ArrowRight size={13} /></Link>
          </div>
          <div className={styles.cameraGrid}>
            {cameras.map((camera, index) => (
              <article className={styles.cameraCard} key={camera.code}>
                <div className={styles.cameraPreview}>
                  <span><Camera size={22} /></span>
                  <em>{camera.code}</em>
                  <i>CHỜ LIVE STREAM</i>
                </div>
                <div className={styles.cameraInfo}>
                  <strong>{camera.location}</strong>
                  <span><MapPin size={11} /> {camera.zone}</span>
                  <small><i className={index < 5 ? styles.readyDot : styles.mutedDot} /> Cấu hình sẵn sàng</small>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div><strong>Cảnh báo gần đây</strong><span>Luồng sự kiện ưu tiên cao</span></div>
            <Link href="/dashboard/alerts">Xem tất cả <ArrowRight size={13} /></Link>
          </div>
          <div className={styles.emptyState}>
            <span><CheckCircle2 size={25} /></span>
            <strong>Chưa có cảnh báo được lưu</strong>
            <p>Khi backend sự kiện được kết nối, vi phạm PPE và hành vi không an toàn sẽ xuất hiện tại đây theo thời gian thực.</p>
            <Link href="/dashboard/alerts">Mở khung quản lý cảnh báo</Link>
          </div>
        </section>
      </div>

      <div className={styles.secondaryGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div><strong>Trạng thái AI pipeline</strong><span>Kết nối mô hình và dữ liệu kiểm thử</span></div>
            <Link href="/dashboard/models">Chi tiết mô hình <ArrowRight size={13} /></Link>
          </div>
          <div className={styles.pipelineList}>
            {(models.length ? models : [
              { name: 'RF-DETR', type: 'detection', version: '—', connected: false, loaded: false, status: 'Chưa kết nối backend' },
              { name: 'VideoMAE', type: 'classification', version: '—', connected: false, loaded: false, status: 'Chưa kết nối backend' },
            ]).map(model => (
              <article key={model.name}>
                <span className={model.connected ? styles.modelOnline : styles.modelOffline}><Bot size={17} /></span>
                <div><strong>{model.name}</strong><small>{model.type} · {model.version || 'chưa có phiên bản'}</small></div>
                <em>{model.connected ? model.loaded ? 'Đã nạp' : 'Sẵn sàng' : 'Ngoại tuyến'}</em>
              </article>
            ))}
            <div className={styles.datasetRow}>
              <span><Database size={16} /></span>
              <div><strong>Video kiểm thử</strong><small>Catalog dữ liệu dành cho demo AI</small></div>
              <em>{health?.test_videos ?? '—'} video</em>
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div><strong>Thao tác nhanh</strong><span>Lối tắt cho vận hành hàng ngày</span></div>
          </div>
          <div className={styles.quickGrid}>
            <Link href="/dashboard/live"><Radio size={18} /><span><strong>Mở trung tâm giám sát</strong><small>Xem các luồng camera</small></span><ArrowRight size={14} /></Link>
            <Link href="/dashboard/alerts"><Siren size={18} /><span><strong>Kiểm tra cảnh báo</strong><small>Xác nhận hoặc báo sai</small></span><ArrowRight size={14} /></Link>
            <Link href="/dashboard/incidents"><FileWarning size={18} /><span><strong>Tạo và giao sự cố</strong><small>Theo dõi quá trình xử lý</small></span><ArrowRight size={14} /></Link>
            <Link href="/dashboard/reports"><Activity size={18} /><span><strong>Xem báo cáo</strong><small>Phân tích xu hướng an toàn</small></span><ArrowRight size={14} /></Link>
          </div>
        </section>
      </div>
    </div>
  );
}

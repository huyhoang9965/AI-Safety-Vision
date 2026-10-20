'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, ArrowRight, Bot, Camera, CheckCircle2, Clock3,
  Database, FileWarning, MapPin, Play, Radio, RefreshCw, Search, Server,
  ShieldAlert, Siren, X,
} from 'lucide-react';
import ReportTrendChart from './report-trend-chart';
import OverviewCameraPreview from './overview-camera-preview';
import { useOverviewData, type DeviceStatus, type OverviewCamera, type OverviewVideo, type Resource } from './use-overview-data';
import styles from './overview.module.css';

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Trực tuyến', offline: 'Ngoại tuyến', warning: 'Cảnh báo', maintenance: 'Bảo trì', disabled: 'Đã tắt',
};
const severityLabels = { low: 'Thấp', medium: 'Trung bình', high: 'Cao', critical: 'Nghiêm trọng' };
const incidentStatusLabels = { open: 'Đang mở', investigating: 'Đang điều tra', resolved: 'Đã xử lý', closed: 'Đã đóng' };
const number = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString('vi-VN');
const time = (value: string | Date | null) => {
  if (!value) return 'Chưa có dữ liệu';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa có dữ liệu' : date.toLocaleString('vi-VN');
};

function ResourceMessage({ resource, allowed = true, loading, empty, children }: {
  resource: Resource<unknown>; allowed?: boolean; loading: boolean; empty: string; children?: ReactNode;
}) {
  if (!allowed) return <div className={styles.emptyState}><ShieldAlert size={24} /><strong>Chưa có quyền xem dữ liệu này</strong><p>Liên hệ quản trị viên để được cấp quyền truy cập.</p></div>;
  if (!resource.data) return <div className={styles.emptyState} role="status">
    {loading ? <RefreshCw size={24} className={styles.spinning} /> : <AlertTriangle size={24} />}
    <strong>{loading ? 'Đang tải dữ liệu…' : 'Chưa tải được dữ liệu'}</strong>
    {!loading && <p>Kiểm tra kết nối rồi bấm Làm mới để thử lại.</p>}
  </div>;
  return <div className={styles.emptyState}><span><CheckCircle2 size={25} /></span><strong>{empty}</strong>{children}</div>;
}
function StaleNotice({ resource }: { resource: Resource<unknown> }) {
  return resource.error && resource.data ? <p className={styles.staleNote} role="status">Đồng bộ thất bại · Dữ liệu lúc {time(resource.updatedAt)}</p> : null;
}
function Kpi({ icon, tone, value, label, detail, state, href }: {
  icon: ReactNode; tone: string; value: string; label: string; detail: string; state: string; href?: string;
}) {
  const content = <><div className={styles.kpiTop}><span className={tone}>{icon}</span><em>{state}</em></div><strong>{value}</strong><p>{label}</p><small>{detail}{href && <ArrowRight size={13} />}</small></>;
  return href ? <Link className={styles.kpiCard} href={href} aria-label={label}>{content}</Link> : <article className={styles.kpiCard}>{content}</article>;
}
function CameraDialog({ camera, videos, catalogLoading, onClose }: { camera: OverviewCamera; videos: OverviewVideo[] | null; catalogLoading: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={styles.cameraDialog} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className={styles.dialogHead}><div><small>{camera.code}</small><h2>{camera.name}</h2></div><button onClick={() => dialog.current?.close()} aria-label="Đóng chi tiết camera"><X size={20} /></button></div>
    <OverviewCameraPreview camera={camera} videos={videos} catalogLoading={catalogLoading} />
    <dl className={styles.cameraDetails}>
      <div><dt>Nhà máy</dt><dd>{camera.site_name}</dd></div><div><dt>Khu vực</dt><dd>{camera.zone_name || 'Chưa phân khu'}</dd></div>
      <div><dt>Trạng thái</dt><dd>{statusLabels[camera.status]}</dd></div><div><dt>Tình trạng thiết bị</dt><dd>{camera.health_status ? statusLabels[camera.health_status] : 'Chưa có dữ liệu'}</dd></div>
      <div><dt>Nguồn phát</dt><dd>{camera.stream_configured ? 'Đã cấu hình' : 'Chưa cấu hình'}</dd></div><div><dt>Lần kết nối gần nhất</dt><dd>{time(camera.last_seen_at)}</dd></div>
    </dl>
  </dialog>;
}

export default function DashboardOverview() {
  const { resources: r, permissions, loading, autoRefresh, setAutoRefresh, refresh, failedSources } = useOverviewData();
  const [cameraSearch, setCameraSearch] = useState('');
  const [cameraStatus, setCameraStatus] = useState('all');
  const [site, setSite] = useState('all');
  const [cameraLimit, setCameraLimit] = useState(6);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const can = (permission: string) => permissions.has(permission);
  const health = r.health.data;
  const infrastructure = r.infrastructure.data;
  const alerts = r.alerts.data;
  const incidents = r.incidents.data;
  const models = r.models.data;
  const videos = r.videos.data;
  const catalogLoading = loading && !videos;
  const systemOnline = health?.status === 'ok' && health.database === 'connected' && !r.health.error;
  const connectedModels = models?.filter(model => model.connected).length;
  const openIncidents = incidents ? incidents.summary.open + incidents.summary.investigating : undefined;
  const selectedCamera = infrastructure?.cameras.find(camera => camera.id === selectedCameraId);
  const filteredCameras = (infrastructure?.cameras || []).filter(camera =>
    (site === 'all' || camera.site_code === site) && (cameraStatus === 'all' || camera.status === cameraStatus) &&
    [camera.code, camera.name, camera.zone_name, camera.site_name].join(' ').toLocaleLowerCase('vi-VN').includes(cameraSearch.trim().toLocaleLowerCase('vi-VN')),
  );
  const resourceState = (resource: Resource<unknown>, allowed = true) => !allowed ? 'Không có quyền xem' : resource.error ? 'Đồng bộ thất bại' : resource.data ? 'Đã đồng bộ' : loading ? 'Đang tải…' : 'Chưa có dữ liệu';

  return <div className={styles.page}>
    <div className={styles.pageHeading}>
      <div><span className={styles.eyebrow}>TRUNG TÂM ĐIỀU HÀNH AN TOÀN</span><h1>Tổng quan hệ thống</h1><p>Theo dõi camera, cảnh báo và tiến độ xử lý sự cố trong một không gian thống nhất.</p></div>
      <div className={styles.headingActions}>
        <button onClick={() => void refresh(true)} disabled={loading}><RefreshCw size={15} className={loading ? styles.spinning : undefined} />{loading ? 'Đang cập nhật' : 'Làm mới'}</button>
        {can('camera.view') && <Link href="/dashboard/live"><Play size={15} />Mở giám sát trực tiếp</Link>}
      </div>
    </div>
    <div className={styles.statusStrip}>
      <span className={systemOnline ? styles.statusOnline : styles.statusOffline}><i />{systemOnline ? 'Hệ thống đang hoạt động' : !health && loading ? 'Đang kiểm tra hệ thống' : r.health.error ? 'Mất kết nối hệ thống' : 'Hệ thống cần kiểm tra'}</span>
      <span><Clock3 size={13} />{r.health.updatedAt ? 'Kiểm tra lúc ' + r.health.updatedAt.toLocaleTimeString('vi-VN') : 'Chưa có dữ liệu cập nhật'}</span>
      <span><Database size={13} />Cơ sở dữ liệu: {r.health.error ? 'Chưa xác minh' : health?.database === 'connected' ? 'Đã kết nối' : health ? 'Mất kết nối' : 'Đang kiểm tra'}</span>
      <label className={styles.autoRefresh}><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />Tự cập nhật 30 giây</label>
    </div>
    {failedSources.length > 0 && <div className={styles.errorBanner} role="alert"><AlertTriangle size={18} /><span>Chưa đồng bộ được: {failedSources.join(', ')}. Các phần đã tải vẫn hiển thị; dữ liệu cũ được ghi rõ thời điểm.</span><button onClick={() => void refresh(true)} disabled={loading}>Thử lại</button></div>}

    <section className={styles.kpiGrid} aria-label="Chỉ số tổng quan">
      <Kpi icon={<Camera size={18} />} tone={styles.blueIcon} value={number(infrastructure?.summary.cameras)} label="Camera giám sát" state={resourceState(r.infrastructure, can('camera.view'))} detail={infrastructure ? `${number(infrastructure.summary.online)} trực tuyến · ${number(infrastructure.summary.offline)} ngoại tuyến` : 'Tổng camera trong tổ chức'} href={can('camera.manage') ? '/dashboard/cameras' : can('camera.view') ? '/dashboard/live' : undefined} />
      <Kpi icon={<Siren size={18} />} tone={styles.orangeIcon} value={number(alerts?.summary.today)} label="Vi phạm hôm nay" state={resourceState(r.alerts, can('event.view'))} detail={alerts ? `${number(alerts.summary.new)} chờ xác nhận · toàn bộ thời gian` : 'Sự kiện an toàn được ghi nhận hôm nay'} href={can('event.view') ? '/dashboard/alerts' : undefined} />
      <Kpi icon={<FileWarning size={18} />} tone={styles.redIcon} value={number(openIncidents)} label="Sự cố đang mở" state={resourceState(r.incidents, can('incident.view'))} detail={incidents ? `${number(incidents.summary.overdue)} quá hạn · ${number(incidents.summary.unassigned)} chưa giao` : 'Gồm đang mở và đang điều tra'} href={can('incident.view') ? '/dashboard/incidents' : undefined} />
      <Kpi icon={<Server size={18} />} tone={styles.greenIcon} value={models ? `${connectedModels}/${models.length}` : '—'} label="Mô hình AI kết nối" state={resourceState(r.models, can('camera.view'))} detail={models ? `${models.filter(model => model.loaded).length} mô hình đã nạp` : 'Trạng thái kết nối mô hình hiện tại'} href={can('camera.manage') ? '/dashboard/models' : undefined} />
    </section>

    <StaleNotice resource={r.alerts} />
    <div className={styles.primaryGrid}>
      <section className={styles.panel} aria-label="Hệ thống camera">
        <div className={styles.panelHeading}><div><strong>Hệ thống camera</strong><span>{infrastructure ? `${number(infrastructure.summary.cameras)} camera trong tổ chức` : 'Theo dõi thiết bị và khu vực'}</span></div>{can('camera.manage') && <Link href="/dashboard/cameras">Quản lý camera <ArrowRight size={13} /></Link>}</div>
        <StaleNotice resource={r.infrastructure} />
        {infrastructure && <>
          <div className={styles.cameraFilters}>
            <label className={styles.cameraSearch}><Search size={15} /><input aria-label="Tìm camera" placeholder="Tên, mã camera, khu vực…" value={cameraSearch} onChange={event => { setCameraSearch(event.target.value); setCameraLimit(6); }} /></label>
            <select aria-label="Nhà máy camera" value={site} onChange={event => { setSite(event.target.value); setCameraLimit(6); }}><option value="all">Tất cả nhà máy</option>{infrastructure.sites.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select>
            <select aria-label="Trạng thái camera" value={cameraStatus} onChange={event => { setCameraStatus(event.target.value); setCameraLimit(6); }}><option value="all">Tất cả trạng thái</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          </div>
          {filteredCameras.length > 0 ? <><div className={styles.cameraGrid}>{filteredCameras.slice(0, cameraLimit).map(camera => <article className={styles.cameraCard} key={camera.id}>
            <OverviewCameraPreview camera={camera} videos={videos} catalogLoading={catalogLoading} enabled={!selectedCameraId} />
            <button className={styles.cameraInfo} onClick={() => setSelectedCameraId(camera.id)} aria-label={'Xem camera ' + camera.code + ' ' + camera.name}><strong>{camera.name}</strong><span><MapPin size={11} />{camera.zone_name || camera.site_name}</span><small data-status={camera.status}><i className={camera.status === 'online' ? styles.readyDot : styles.mutedDot} />{statusLabels[camera.status]}</small></button>
          </article>)}</div><div className={styles.cameraFooter}><span>Hiển thị {Math.min(cameraLimit, filteredCameras.length)}/{filteredCameras.length} camera</span>{filteredCameras.length > cameraLimit && <button onClick={() => setCameraLimit(limit => limit + 6)}>Xem thêm camera</button>}</div></> : <ResourceMessage resource={r.infrastructure} loading={loading} empty={infrastructure.cameras.length ? 'Không tìm thấy camera phù hợp' : 'Chưa có camera trong tổ chức'}>{infrastructure.cameras.length > 0 && <button className={styles.textButton} onClick={() => { setCameraSearch(''); setCameraStatus('all'); setSite('all'); }}>Xóa bộ lọc</button>}</ResourceMessage>}
        </>}
        {!infrastructure && <ResourceMessage resource={r.infrastructure} allowed={can('camera.view')} loading={loading} empty="Chưa có camera" />}
      </section>

    </div>

    {can('report.view') && <section aria-label="Xu hướng an toàn 7 ngày"><div className={styles.trendHeading}><div><h2>Xu hướng an toàn 7 ngày</h2><p>Số liệu từ các cảnh báo và sự cố đã lưu</p></div><Link href="/dashboard/reports">Xem báo cáo <ArrowRight size={13} /></Link></div><StaleNotice resource={r.reports} />{r.reports.data ? <ReportTrendChart rows={r.reports.data.trend} /> : <div className={styles.panel}><ResourceMessage resource={r.reports} loading={loading} empty="Chưa có dữ liệu xu hướng" /></div>}</section>}

    <div className={styles.secondaryGrid}>
      <section className={styles.panel} aria-label="Sự cố cần xử lý">
        <div className={styles.panelHeading}><div><strong>Sự cố cần xử lý</strong><span>Ưu tiên hồ sơ đang mở và đang điều tra</span></div>{can('incident.view') && <Link href="/dashboard/incidents">Quản lý sự cố <ArrowRight size={13} /></Link>}</div>
        <StaleNotice resource={r.incidents} />
        {incidents && <div className={styles.incidentSummary}><span><b>{number(incidents.summary.open)}</b> đang mở</span><span><b>{number(incidents.summary.investigating)}</b> đang điều tra</span><span><b>{number(incidents.summary.overdue)}</b> quá hạn</span></div>}
        {incidents?.items.some(item => item.status === 'open' || item.status === 'investigating') ? <div className={styles.eventList}>{incidents.items.filter(item => item.status === 'open' || item.status === 'investigating').map(item => <article key={item.id} className={styles.incidentItem}><FileWarning size={18} /><div><strong>#{item.incident_no} · {item.title}</strong><small>{item.assigned_to?.full_name || 'Chưa giao người xử lý'}</small></div><div className={styles.badges}><span data-severity={item.severity}>{severityLabels[item.severity]}</span><span>{incidentStatusLabels[item.status]}</span>{item.overdue && <span data-severity="critical">Quá hạn</span>}</div></article>)}</div> : <ResourceMessage resource={r.incidents} allowed={can('incident.view')} loading={loading} empty="Không có sự cố đang chờ xử lý" />}
      </section>
      <section className={styles.panel} aria-label="Trạng thái AI pipeline">
        <div className={styles.panelHeading}><div><strong>Trạng thái AI pipeline</strong><span>Kết nối và trạng thái nạp mô hình</span></div>{can('camera.manage') && <Link href="/dashboard/models">Chi tiết mô hình <ArrowRight size={13} /></Link>}</div>
        <StaleNotice resource={r.models} />
        {models?.length ? <div className={styles.pipelineList}>{models.map(model => <article key={model.name}><span className={model.connected ? styles.modelOnline : styles.modelOffline}><Bot size={17} /></span><div><strong>{model.name}</strong><small>{model.type === 'detection' ? 'Phát hiện đối tượng' : model.type === 'classification' ? 'Phân loại hành vi' : model.type} · {model.version || 'Chưa có phiên bản'}</small></div><em>{model.connected ? model.loaded ? 'Đã nạp' : 'Sẵn sàng' : 'Ngoại tuyến'}</em></article>)}{health && <div className={styles.datasetRow}><span><Database size={16} /></span><div><strong>Video kiểm thử</strong><small>Dữ liệu dành cho giám sát demo</small></div><em>{number(health.test_videos)} video</em></div>}</div> : <ResourceMessage resource={r.models} allowed={can('camera.view')} loading={loading} empty="Chưa có mô hình được cấu hình" />}
      </section>
    </div>

    <section className={styles.panel} aria-label="Thao tác nhanh">
      <div className={styles.panelHeading}><div><strong>Thao tác nhanh</strong><span>Lối tắt cho vận hành hàng ngày</span></div></div>
      <div className={styles.quickGrid}>
        {can('camera.view') && <Link href="/dashboard/live"><Radio size={18} /><span><strong>Mở trung tâm giám sát</strong><small>Xem các nguồn camera</small></span><ArrowRight size={14} /></Link>}
        {can('event.view') && <Link href="/dashboard/alerts"><Siren size={18} /><span><strong>Kiểm tra cảnh báo</strong><small>Theo dõi cảnh báo cần xử lý</small></span><ArrowRight size={14} /></Link>}
        {can('incident.view') && <Link href="/dashboard/incidents"><FileWarning size={18} /><span><strong>Quản lý sự cố</strong><small>Theo dõi tiến độ xử lý</small></span><ArrowRight size={14} /></Link>}
        {can('report.view') && <Link href="/dashboard/reports"><Activity size={18} /><span><strong>Xem báo cáo</strong><small>Phân tích xu hướng an toàn</small></span><ArrowRight size={14} /></Link>}
      </div>
      {!['camera.view', 'event.view', 'incident.view', 'report.view'].some(can) && <p className={styles.staleNote}>Tài khoản hiện chỉ có quyền xem trang tổng quan.</p>}
    </section>
    {selectedCamera && <CameraDialog key={selectedCamera.id} camera={selectedCamera} videos={videos} catalogLoading={catalogLoading} onClose={() => setSelectedCameraId(null)} />}
  </div>;
}
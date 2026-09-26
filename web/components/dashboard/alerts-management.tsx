'use client';

import {
  Activity,
  AlertOctagon,
  BellRing,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  Eye,
  FileWarning,
  Filter,
  ImageOff,
  LoaderCircle,
  MapPin,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  Siren,
  Sparkles,
  TimerReset,
  UserCheck,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readAuthSession, userPermissions } from '@/lib/auth';
import styles from './alerts-management.module.css';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

type Severity = 'low' | 'medium' | 'high' | 'critical';
type AlertStatus = 'new' | 'acknowledged' | 'resolved' | 'dismissed';

type Actor = { id: string; full_name: string };

type AlertItem = {
  id: string;
  event_code: string;
  event_name: string;
  title: string;
  description: string | null;
  severity: Severity;
  status: AlertStatus;
  confidence: number | null;
  object_count: number;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  site_code: string;
  site_name: string;
  zone_code: string | null;
  zone_name: string | null;
  camera_code: string;
  camera_name: string;
  snapshot_url: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  acknowledged_by: Actor | null;
  resolved_by: Actor | null;
  incident_id: string | null;
};

type Summary = {
  total: number;
  new: number;
  acknowledged: number;
  resolved: number;
  dismissed: number;
  critical_open: number;
  high_open: number;
  today: number;
  average_acknowledge_seconds: number | null;
};

type Option = { code: string; name: string };

type AlertResponse = {
  items: AlertItem[];
  total: number;
  limit: number;
  offset: number;
  summary: Summary;
  filters: {
    event_types: Option[];
    sites: Option[];
    cameras: Option[];
  };
};

type ActionType = 'acknowledge' | 'resolve' | 'dismiss' | 'incident';

const EMPTY_SUMMARY: Summary = {
  total: 0,
  new: 0,
  acknowledged: 0,
  resolved: 0,
  dismissed: 0,
  critical_open: 0,
  high_open: 0,
  today: 0,
  average_acknowledge_seconds: null,
};

const statusLabels: Record<AlertStatus, string> = {
  new: 'Mới',
  acknowledged: 'Đã xác nhận',
  resolved: 'Đã xử lý',
  dismissed: 'Cảnh báo sai',
};

const severityLabels: Record<Severity, string> = {
  low: 'Thấp',
  medium: 'Trung bình',
  high: 'Cao',
  critical: 'Nghiêm trọng',
};

function requestHeaders(): HeadersInit {
  const stored = readAuthSession();
  return {
    'Content-Type': 'application/json',
    ...(stored ? { Authorization: 'Bearer ' + stored.session.access_token } : {}),
  };
}

function assetUrl(path: string | null): string {
  if (!path) return '';
  return /^https?:\/\//.test(path) ? path : API_BASE + path;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds + ' giây trước';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' phút trước';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' giờ trước';
  return Math.floor(seconds / 86400) + ' ngày trước';
}

function fullDate(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return 'Chưa có dữ liệu';
  if (seconds < 60) return Math.round(seconds) + ' giây';
  return Math.round(seconds / 60) + ' phút';
}

function apiError(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    return String((payload as { detail: unknown }).detail);
  }
  return 'Yêu cầu không thể hoàn thành.';
}

export default function AlertsManagement() {
  const [data, setData] = useState<AlertResponse>({
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    summary: EMPTY_SUMMARY,
    filters: { event_types: [], sites: [], cameras: [] },
  });
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [status, setStatus] = useState<'all' | AlertStatus>('all');
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [eventType, setEventType] = useState('all');
  const [site, setSite] = useState('all');
  const [period, setPeriod] = useState('all');
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [action, setAction] = useState<ActionType | null>(null);
  const [note, setNote] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);

  const stored = typeof window === 'undefined' ? null : readAuthSession();
  const permissions = useMemo(
    () => stored ? userPermissions(stored.session.user) : new Set<string>(),
    [stored],
  );

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      period,
      limit: '50',
      offset: String(offset),
    });
    if (search) params.set('search', search);
    if (status !== 'all') params.set('status', status);
    if (severity !== 'all') params.set('severity', severity);
    if (eventType !== 'all') params.set('event_type', eventType);
    if (site !== 'all') params.set('site', site);
    return params.toString();
  }, [eventType, offset, period, search, severity, site, status]);

  const loadAlerts = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const response = await fetch(API_BASE + '/api/alerts?' + queryString, {
        headers: requestHeaders(),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      const next = payload as AlertResponse;
      setData(next);
      setSelectedId(current => next.items.some(item => item.id === current)
        ? current
        : next.items[0]?.id || '');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải cảnh báo.');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadAlerts(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadAlerts]);

  const selected = data.items.find(item => item.id === selectedId) || null;
  const page = Math.floor(offset / data.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  };

  const resetFilters = () => {
    setSearch('');
    setSearchInput('');
    setStatus('all');
    setSeverity('all');
    setEventType('all');
    setSite('all');
    setPeriod('24h');
    setOffset(0);
  };

  const openAction = (nextAction: ActionType) => {
    setAction(nextAction);
    setNote('');
  };

  const submitAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !action) return;
    setActionBusy(true);
    try {
      const body = action === 'incident'
        ? { title: note.trim() || selected.title }
        : { note: note.trim() || null };
      const response = await fetch(API_BASE + '/api/alerts/' + selected.id + '/' + action, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      setToast(String(payload?.message || 'Đã cập nhật cảnh báo.'));
      setAction(null);
      setNote('');
      await loadAlerts(true);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : 'Không thể cập nhật cảnh báo.');
    } finally {
      setActionBusy(false);
    }
  };

  const exportCsv = () => {
    if (!data.items.length) {
      setToast('Không có dữ liệu để xuất.');
      return;
    }
    const rows = [
      ['Mã', 'Loại', 'Tiêu đề', 'Mức độ', 'Trạng thái', 'Camera', 'Khu vực', 'Thời gian'],
      ...data.items.map(item => [
        item.id,
        item.event_name,
        item.title,
        severityLabels[item.severity],
        statusLabels[item.status],
        item.camera_code,
        item.zone_name || item.site_name,
        fullDate(item.detected_at),
      ]),
    ];
    const csv = rows.map(row => row.map(cell => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    link.download = 'safety-alerts-' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const selectAlert = (item: AlertItem) => {
    setSelectedId(item.id);
    setMobileDetail(true);
  };

  return (
    <div className={styles.page}>
      {toast && <button className={styles.toast} type="button" onClick={() => setToast('')}><Check size={16} /><span>{toast}</span><X size={14} /></button>}

      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}><Siren size={13} /> TRUNG TÂM CẢNH BÁO AN TOÀN</span>
          <h1>Cảnh báo và vi phạm</h1>
          <p>Tiếp nhận, xác minh và xử lý các phát hiện từ camera và mô hình AI trong một quy trình thống nhất.</p>
        </div>
        <div className={styles.headingActions}>
          <button type="button" className={autoRefresh ? styles.liveButton : undefined} onClick={() => setAutoRefresh(value => !value)}>
            <i /> {autoRefresh ? 'Tự động 5 giây' : 'Đã tạm dừng'}
          </button>
          <button type="button" onClick={() => void loadAlerts()} disabled={loading}><RefreshCw className={loading ? styles.spinning : undefined} size={15} /> Làm mới</button>
          <button type="button" onClick={exportCsv}><Download size={15} /> Xuất CSV</button>
        </div>
      </header>

      <section className={styles.metrics}>
        <article>
          <span className={styles.redIcon}><AlertOctagon size={19} /></span>
          <div><small>Đang chờ xử lý</small><strong>{data.summary.new}</strong></div>
          <em>{data.summary.critical_open} nghiêm trọng</em>
        </article>
        <article>
          <span className={styles.orangeIcon}><UserCheck size={19} /></span>
          <div><small>Đã xác nhận</small><strong>{data.summary.acknowledged}</strong></div>
          <em>Đang được theo dõi</em>
        </article>
        <article>
          <span className={styles.blueIcon}><BellRing size={19} /></span>
          <div><small>Phát hiện hôm nay</small><strong>{data.summary.today}</strong></div>
          <em>{data.summary.high_open} mức cao đang mở</em>
        </article>
        <article>
          <span className={styles.greenIcon}><TimerReset size={19} /></span>
          <div><small>Thời gian xác nhận TB</small><strong>{durationLabel(data.summary.average_acknowledge_seconds)}</strong></div>
          <em>{data.summary.resolved} đã xử lý</em>
        </article>
      </section>

      <section className={styles.filterPanel}>
        <div className={styles.statusTabs}>
          {([
            ['all', 'Tất cả', data.summary.total],
            ['new', 'Mới', data.summary.new],
            ['acknowledged', 'Đã xác nhận', data.summary.acknowledged],
            ['resolved', 'Đã xử lý', data.summary.resolved],
            ['dismissed', 'Cảnh báo sai', data.summary.dismissed],
          ] as const).map(tab => (
            <button key={tab[0]} type="button" className={status === tab[0] ? styles.activeTab : undefined} onClick={() => { setStatus(tab[0]); setOffset(0); }}>
              {tab[1]} <span>{tab[2]}</span>
            </button>
          ))}
        </div>
        <div className={styles.filters}>
          <form className={styles.search} onSubmit={submitSearch}>
            <Search size={15} />
            <input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Tìm tiêu đề, camera..." />
          </form>
          <label><Filter size={14} /><select value={severity} onChange={event => { setSeverity(event.target.value as typeof severity); setOffset(0); }}><option value="all">Mọi mức độ</option><option value="critical">Nghiêm trọng</option><option value="high">Cao</option><option value="medium">Trung bình</option><option value="low">Thấp</option></select><ChevronDown size={12} /></label>
          <label><select value={eventType} onChange={event => { setEventType(event.target.value); setOffset(0); }}><option value="all">Mọi loại vi phạm</option>{data.filters.event_types.map(option => <option value={option.code} key={option.code}>{option.name}</option>)}</select><ChevronDown size={12} /></label>
          <label><select value={site} onChange={event => { setSite(event.target.value); setOffset(0); }}><option value="all">Mọi địa điểm</option>{data.filters.sites.map(option => <option value={option.code} key={option.code}>{option.name}</option>)}</select><ChevronDown size={12} /></label>
          <label><Clock3 size={14} /><select value={period} onChange={event => { setPeriod(event.target.value); setOffset(0); }}><option value="today">Hôm nay</option><option value="24h">24 giờ qua</option><option value="7d">7 ngày qua</option><option value="30d">30 ngày qua</option><option value="all">Toàn bộ</option></select><ChevronDown size={12} /></label>
          <button type="button" onClick={resetFilters}>Đặt lại</button>
        </div>
      </section>

      {error ? (
        <section className={styles.errorState}>
          <span><XCircle size={24} /></span><strong>Không thể tải cảnh báo</strong><p>{error}</p>
          <button type="button" onClick={() => void loadAlerts()}><RefreshCw size={14} /> Thử lại</button>
        </section>
      ) : (
        <section className={styles.workspace}>
          <div className={styles.listPanel}>
            <div className={styles.listHeading}>
              <div><strong>Hàng đợi cảnh báo</strong><span>{data.total} kết quả phù hợp</span></div>
              <span><Activity size={13} /> Ưu tiên theo trạng thái và rủi ro</span>
            </div>

            <div className={styles.alertList}>
              {loading && !data.items.length ? (
                <div className={styles.loadingState}><LoaderCircle className={styles.spinning} size={24} /><span>Đang tải dữ liệu cảnh báo...</span></div>
              ) : data.items.length ? data.items.map(item => (
                <button
                  type="button"
                  key={item.id}
                  className={selectedId === item.id ? styles.alertRow + ' ' + styles.selectedRow : styles.alertRow}
                  onClick={() => selectAlert(item)}
                >
                  <span className={styles.severityBar} data-severity={item.severity} />
                  <span className={styles.alertIcon} data-severity={item.severity}><ShieldAlert size={17} /></span>
                  <span className={styles.alertMain}>
                    <span><strong>{item.title}</strong><em data-status={item.status}>{statusLabels[item.status]}</em></span>
                    <small>{item.event_name} · {item.camera_code} · {item.zone_name || item.site_name}</small>
                    <span className={styles.alertMeta}><span><Clock3 size={11} /> {relativeTime(item.detected_at)}</span><span><Camera size={11} /> {item.camera_name}</span>{item.confidence !== null && <span><Sparkles size={11} /> {Math.round(item.confidence * 100)}%</span>}</span>
                  </span>
                  <span className={styles.severityBadge} data-severity={item.severity}>{severityLabels[item.severity]}</span>
                  <ChevronRight size={15} />
                </button>
              )) : (
                <div className={styles.emptyState}>
                  <span><CheckCircle2 size={27} /></span>
                  <strong>Không có cảnh báo phù hợp</strong>
                  <p>Hệ thống không tạo dữ liệu minh họa. Cảnh báo thật từ bảng <code>safety.safety_events</code> sẽ xuất hiện tại đây.</p>
                  <button type="button" onClick={resetFilters}>Xóa bộ lọc</button>
                </div>
              )}
            </div>

            <div className={styles.pagination}>
              <span>Trang {page}/{totalPages} · {data.total} cảnh báo</span>
              <div>
                <button type="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - data.limit))}><ChevronLeft size={14} /></button>
                <button type="button" disabled={offset + data.limit >= data.total} onClick={() => setOffset(value => value + data.limit)}><ChevronRight size={14} /></button>
              </div>
            </div>
          </div>

          <aside className={mobileDetail ? styles.detailPanel + ' ' + styles.mobileDetail : styles.detailPanel}>
            {selected ? (
              <>
                <div className={styles.detailHeader}>
                  <div><span data-severity={selected.severity}>{severityLabels[selected.severity]}</span><em data-status={selected.status}>{statusLabels[selected.status]}</em></div>
                  <button type="button" onClick={() => setMobileDetail(false)}><X size={16} /></button>
                </div>
                <div className={styles.detailTitle}>
                  <span><ShieldAlert size={20} /></span>
                  <div><small>{selected.event_code}</small><h2>{selected.title}</h2><p>{selected.event_name}</p></div>
                </div>

                <div className={styles.evidence}>
                  {selected.snapshot_url || selected.thumbnail_url ? (
                    <img src={assetUrl(selected.snapshot_url || selected.thumbnail_url)} alt={'Bằng chứng ' + selected.title} />
                  ) : (
                    <div><ImageOff size={25} /><strong>Chưa có ảnh bằng chứng</strong><span>Pipeline có thể cập nhật snapshot_url hoặc thumbnail_url.</span></div>
                  )}
                  <span><Camera size={12} /> {selected.camera_code}</span>
                  {selected.confidence !== null && <em><Sparkles size={12} /> Độ tin cậy {Math.round(selected.confidence * 100)}%</em>}
                </div>
                {(selected.snapshot_url || selected.thumbnail_url) && (
                  <a
                    className={styles.evidenceOriginal}
                    href={assetUrl(selected.snapshot_url || selected.thumbnail_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Mở ảnh bằng chứng gốc ↗
                  </a>
                )}

                <div className={styles.detailMeta}>
                  <div><small>Thời gian phát hiện</small><strong>{fullDate(selected.detected_at)}</strong></div>
                  <div><small>Địa điểm</small><strong>{selected.site_name}</strong><span><MapPin size={10} /> {selected.zone_name || 'Chưa gán khu vực'}</span></div>
                  <div><small>Camera</small><strong>{selected.camera_code}</strong><span>{selected.camera_name}</span></div>
                  <div><small>Đối tượng</small><strong>{selected.object_count}</strong><span>đối tượng liên quan</span></div>
                </div>

                <div className={styles.description}>
                  <strong>Mô tả phát hiện</strong>
                  <p>{selected.description || 'Chưa có mô tả chi tiết cho cảnh báo này.'}</p>
                </div>

                <div className={styles.timeline}>
                  <strong>Lịch sử xử lý</strong>
                  <div className={styles.timelineItem}>
                    <span><BellRing size={13} /></span>
                    <div><strong>AI ghi nhận cảnh báo</strong><small>{fullDate(selected.detected_at)}</small></div>
                  </div>
                  {selected.acknowledged_at && <div className={styles.timelineItem}><span><UserCheck size={13} /></span><div><strong>{selected.acknowledged_by?.full_name || 'Người vận hành'} đã xác nhận</strong><small>{fullDate(selected.acknowledged_at)}</small></div></div>}
                  {selected.resolved_at && <div className={styles.timelineItem}><span><CheckCircle2 size={13} /></span><div><strong>{selected.status === 'dismissed' ? 'Đánh dấu cảnh báo sai' : 'Hoàn tất xử lý'}</strong><small>{fullDate(selected.resolved_at)}</small></div></div>}
                  {selected.resolution_note && <blockquote>{selected.resolution_note}</blockquote>}
                </div>

                {selected.video_url && <a className={styles.videoLink} href={assetUrl(selected.video_url)} target="_blank" rel="noreferrer"><Video size={14} /> Mở video bằng chứng</a>}

                <div className={styles.detailActions}>
                  {selected.status === 'new' && permissions.has('event.acknowledge') && <button type="button" className={styles.primaryAction} onClick={() => openAction('acknowledge')}><UserCheck size={15} /> Xác nhận</button>}
                  {['new', 'acknowledged'].includes(selected.status) && permissions.has('event.resolve') && <button type="button" onClick={() => openAction('resolve')}><CheckCircle2 size={15} /> Đã xử lý</button>}
                  {['new', 'acknowledged'].includes(selected.status) && permissions.has('event.resolve') && <button type="button" onClick={() => openAction('dismiss')}><XCircle size={15} /> Báo sai</button>}
                  {!selected.incident_id && permissions.has('incident.manage') && <button type="button" onClick={() => openAction('incident')}><FileWarning size={15} /> Tạo sự cố</button>}
                  {selected.incident_id && <span><FileWarning size={13} /> Đã liên kết sự cố</span>}
                </div>
              </>
            ) : (
              <div className={styles.noSelection}><Eye size={24} /><strong>Chọn một cảnh báo</strong><p>Thông tin bằng chứng và lịch sử xử lý sẽ hiển thị tại đây.</p></div>
            )}
          </aside>
        </section>
      )}

      {action && selected && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) setAction(null); }}>
          <form className={styles.actionModal} onSubmit={submitAction}>
            <div className={styles.modalHeading}>
              <span>{action === 'acknowledge' ? <UserCheck size={19} /> : action === 'resolve' ? <CheckCircle2 size={19} /> : action === 'dismiss' ? <XCircle size={19} /> : <FileWarning size={19} />}</span>
              <div><strong>{action === 'acknowledge' ? 'Xác nhận cảnh báo' : action === 'resolve' ? 'Hoàn tất xử lý' : action === 'dismiss' ? 'Đánh dấu cảnh báo sai' : 'Tạo phiếu sự cố'}</strong><small>{selected.camera_code} · {selected.title}</small></div>
              <button type="button" onClick={() => setAction(null)}><X size={16} /></button>
            </div>
            <label>
              <span>{action === 'incident' ? 'Tiêu đề phiếu sự cố' : action === 'acknowledge' ? 'Ghi chú xác nhận (không bắt buộc)' : 'Ghi chú xử lý'}</span>
              <textarea value={note} onChange={event => setNote(event.target.value)} required={action === 'resolve' || action === 'dismiss'} placeholder={action === 'dismiss' ? 'Nhập lý do xác định đây là cảnh báo sai...' : action === 'incident' ? selected.title : 'Mô tả hành động đã thực hiện...'} />
            </label>
            <div className={styles.modalActions}>
              <button type="button" onClick={() => setAction(null)}>Hủy</button>
              <button type="submit" disabled={actionBusy}>{actionBusy ? <LoaderCircle className={styles.spinning} size={14} /> : <Check size={14} />} Xác nhận thao tác</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

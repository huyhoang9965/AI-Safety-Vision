'use client';

import {
  Activity, AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleDot, ClipboardCheck, Columns3, Download,
  FileWarning, Filter, History, LayoutList, LoaderCircle, MapPin, MessageSquare,
  Pencil, Plus, RefreshCw, Search, Send, ShieldAlert, Siren, Target, TimerOff,
  User, UserCheck, Users, X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readAuthSession, userPermissions } from '@/lib/auth';
import styles from './incidents-management.module.css';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
type Severity = 'low' | 'medium' | 'high' | 'critical';
type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'closed';
type ViewMode = 'board' | 'list';
type DetailTab = 'overview' | 'activity' | 'alerts';
type IncidentUser = { id: string; full_name: string; email: string | null };
type IncidentItem = {
  id: string; incident_no: number; title: string; description: string | null;
  severity: Severity; status: IncidentStatus; site_code: string; site_name: string;
  assigned_to: IncidentUser | null; opened_by: IncidentUser | null;
  opened_at: string; due_at: string | null; resolved_at: string | null;
  closed_at: string | null; updated_at: string; event_count: number;
  comment_count: number; overdue: boolean;
};
type IncidentComment = {
  id: string; body: string; created_at: string; updated_at: string;
  user: IncidentUser | null;
};
type IncidentHistory = {
  id: number; old_status: IncidentStatus | null; new_status: IncidentStatus;
  note: string | null; changed_at: string; changed_by: IncidentUser | null;
};
type LinkedEvent = {
  id: string; title: string; severity: Severity; status: string; detected_at: string;
  event_name: string; camera_code: string; camera_name: string; snapshot_url: string | null;
};
type IncidentDetail = IncidentItem & {
  resolution: string | null; root_cause: string | null; corrective_action: string | null;
  comments: IncidentComment[]; history: IncidentHistory[]; linked_events: LinkedEvent[];
};
type Summary = {
  total: number; open: number; investigating: number; resolved: number; closed: number;
  overdue: number; critical_open: number; unassigned: number;
  average_resolution_seconds: number | null;
};
type Option = { code: string; name: string };
type Member = { id: string; full_name: string; email: string };
type IncidentResponse = {
  items: IncidentItem[]; total: number; limit: number; offset: number; summary: Summary;
  filters: { sites: Option[]; members: Member[] };
};
type EditorValues = {
  site_code: string; title: string; description: string; severity: Severity;
  assigned_to: string; due_at: string; root_cause: string;
  corrective_action: string; resolution: string;
};

const EMPTY_SUMMARY: Summary = {
  total: 0, open: 0, investigating: 0, resolved: 0, closed: 0,
  overdue: 0, critical_open: 0, unassigned: 0, average_resolution_seconds: null,
};
const statusLabels: Record<IncidentStatus, string> = {
  open: 'Mới mở', investigating: 'Đang điều tra', resolved: 'Đã xử lý', closed: 'Đã đóng',
};
const severityLabels: Record<Severity, string> = {
  low: 'Thấp', medium: 'Trung bình', high: 'Cao', critical: 'Nghiêm trọng',
};
const columns: Array<{ status: IncidentStatus; title: string; description: string }> = [
  { status: 'open', title: 'Mới mở', description: 'Chờ tiếp nhận và phân công' },
  { status: 'investigating', title: 'Đang điều tra', description: 'Đang xác minh và khắc phục' },
  { status: 'resolved', title: 'Đã xử lý', description: 'Chờ rà soát để đóng' },
  { status: 'closed', title: 'Đã đóng', description: 'Hoàn tất hồ sơ' },
];

function headers(): HeadersInit {
  const stored = readAuthSession();
  return {
    'Content-Type': 'application/json',
    ...(stored ? { Authorization: 'Bearer ' + stored.session.access_token } : {}),
  };
}
function apiError(payload: unknown): string {
  return payload && typeof payload === 'object' && 'detail' in payload
    ? String((payload as { detail: unknown }).detail) : 'Không thể hoàn thành yêu cầu.';
}
function fullDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Chưa thiết lập';
}
function shortDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value)) : 'Chưa đặt hạn';
}
function relativeTime(value: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'Vừa xong';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' phút trước';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' giờ trước';
  return Math.floor(seconds / 86400) + ' ngày trước';
}
function resolutionTime(seconds: number | null): string {
  if (seconds === null) return '—';
  return seconds < 3600 ? Math.round(seconds / 60) + ' phút' : (seconds / 3600).toFixed(1) + ' giờ';
}
function toLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function emptyEditor(site = ''): EditorValues {
  return { site_code: site, title: '', description: '', severity: 'medium', assigned_to: '', due_at: '', root_cause: '', corrective_action: '', resolution: '' };
}

export default function IncidentsManagement() {
  const [data, setData] = useState<IncidentResponse>({
    items: [], total: 0, limit: 100, offset: 0, summary: EMPTY_SUMMARY,
    filters: { sites: [], members: [] },
  });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewMode>('board');
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | IncidentStatus>('all');
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [site, setSite] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [period, setPeriod] = useState('30d');
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editor, setEditor] = useState<EditorValues>(emptyEditor());
  const [statusModal, setStatusModal] = useState<IncidentStatus | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const permissions = useMemo(() => {
    if (typeof window === 'undefined') return new Set<string>();
    const stored = readAuthSession();
    return stored ? userPermissions(stored.session.user) : new Set<string>();
  }, []);
  const canManage = permissions.has('incident.manage');
  const query = useMemo(() => {
    const params = new URLSearchParams({ period, limit: '100', offset: '0' });
    if (search) params.set('search', search);
    if (status !== 'all') params.set('status', status);
    if (severity !== 'all') params.set('severity', severity);
    if (site !== 'all') params.set('site', site);
    if (assignee !== 'all') params.set('assignee', assignee);
    return params.toString();
  }, [assignee, period, search, severity, site, status]);

  const loadIncidents = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const response = await fetch(API_BASE + '/api/incidents?' + query, { headers: headers() });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      const next = payload as IncidentResponse;
      setData(next);
      setSelectedId(current => next.items.some(item => item.id === current) ? current : next.items[0]?.id || '');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải sự cố.');
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => { void loadIncidents(); }, [loadIncidents]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const response = await fetch(API_BASE + '/api/incidents/' + id, { headers: headers() });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      setDetail(payload as IncidentDetail);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : 'Không thể tải hồ sơ.');
    } finally {
      setDetailLoading(false);
    }
  }, []);
  useEffect(() => { void loadDetail(selectedId); }, [loadDetail, selectedId]);

  const selectIncident = (item: IncidentItem) => {
    setSelectedId(item.id); setDetailTab('overview'); setMobileDetail(true);
  };
  const resetFilters = () => {
    setSearch(''); setSearchInput(''); setStatus('all'); setSeverity('all');
    setSite('all'); setAssignee('all'); setPeriod('30d');
  };
  const openCreate = () => {
    setEditor(emptyEditor(data.filters.sites[0]?.code || '')); setEditorMode('create');
  };
  const openEdit = () => {
    if (!detail) return;
    setEditor({
      site_code: detail.site_code, title: detail.title, description: detail.description || '',
      severity: detail.severity, assigned_to: detail.assigned_to?.id || '',
      due_at: toLocalInput(detail.due_at), root_cause: detail.root_cause || '',
      corrective_action: detail.corrective_action || '', resolution: detail.resolution || '',
    });
    setEditorMode('edit');
  };
  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editorMode) return;
    setBusy(true);
    try {
      const body = {
        ...(editorMode === 'create' ? { site_code: editor.site_code } : {}),
        title: editor.title.trim(), description: editor.description.trim() || null,
        severity: editor.severity, assigned_to: editor.assigned_to || null,
        due_at: editor.due_at ? new Date(editor.due_at).toISOString() : null,
        ...(editorMode === 'edit' ? {
          root_cause: editor.root_cause.trim() || null,
          corrective_action: editor.corrective_action.trim() || null,
          resolution: editor.resolution.trim() || null,
        } : {}),
      };
      const path = editorMode === 'create' ? '/api/incidents' : '/api/incidents/' + selectedId + '/update';
      const response = await fetch(API_BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      setSelectedId(payload.incident.id); setDetail(payload.incident); setEditorMode(null);
      setToast(String(payload.message)); await loadIncidents(true);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : 'Không thể lưu sự cố.');
    } finally { setBusy(false); }
  };
  const changeStatus = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !statusModal) return;
    setBusy(true);
    try {
      const response = await fetch(API_BASE + '/api/incidents/' + selectedId + '/status', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ status: statusModal, note: statusNote.trim() || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      setDetail(payload.incident); setStatusModal(null); setStatusNote('');
      setToast(String(payload.message)); await loadIncidents(true);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : 'Không thể đổi trạng thái.');
    } finally { setBusy(false); }
  };
  const addComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !comment.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(API_BASE + '/api/incidents/' + selectedId + '/comments', {
        method: 'POST', headers: headers(), body: JSON.stringify({ body: comment.trim() }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      setDetail(payload.incident); setComment(''); await loadIncidents(true);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : 'Không thể thêm bình luận.');
    } finally { setBusy(false); }
  };
  const exportCsv = () => {
    if (!data.items.length) { setToast('Không có dữ liệu để xuất.'); return; }
    const rows = [
      ['Mã', 'Tiêu đề', 'Mức độ', 'Trạng thái', 'Địa điểm', 'Phụ trách', 'Ngày mở', 'Hạn xử lý'],
      ...data.items.map(item => ['INC-' + String(item.incident_no).padStart(5, '0'), item.title,
        severityLabels[item.severity], statusLabels[item.status], item.site_name,
        item.assigned_to?.full_name || 'Chưa phân công', fullDate(item.opened_at), fullDate(item.due_at)]),
    ];
    const csv = rows.map(row => row.map(cell => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = 'incidents-' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click(); URL.revokeObjectURL(url);
  };
  const nextActions = detail ? {
    open: [{ status: 'investigating' as const, label: 'Bắt đầu điều tra' }, { status: 'resolved' as const, label: 'Xử lý ngay' }],
    investigating: [{ status: 'open' as const, label: 'Trả về mới mở' }, { status: 'resolved' as const, label: 'Đánh dấu đã xử lý' }],
    resolved: [{ status: 'investigating' as const, label: 'Mở lại điều tra' }, { status: 'closed' as const, label: 'Đóng hồ sơ' }],
    closed: [],
  }[detail.status] : [];

  return (
    <div className={styles.page}>
      {toast && <button className={styles.toast} type="button" onClick={() => setToast('')}><Check size={16} /><span>{toast}</span><X size={14} /></button>}
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}><FileWarning size={13} /> ĐIỀU PHỐI VÀ KHẮC PHỤC</span>
          <h1>Quản lý sự cố</h1>
          <p>Theo dõi toàn bộ vòng đời sự cố, từ tiếp nhận và phân công đến điều tra, khắc phục và đóng hồ sơ.</p>
        </div>
        <div className={styles.headingActions}>
          <button type="button" onClick={() => void loadIncidents()} disabled={loading}><RefreshCw className={loading ? styles.spinning : undefined} size={15} /> Làm mới</button>
          <button type="button" onClick={exportCsv}><Download size={15} /> Xuất CSV</button>
          {canManage && <button className={styles.createButton} type="button" onClick={openCreate}><Plus size={15} /> Tạo sự cố</button>}
        </div>
      </header>

      <section className={styles.metrics}>
        <article><span className={styles.redIcon}><Siren size={19} /></span><div><small>Đang mở</small><strong>{data.summary.open + data.summary.investigating}</strong></div><em>{data.summary.critical_open} mức nghiêm trọng</em></article>
        <article><span className={styles.orangeIcon}><Activity size={19} /></span><div><small>Đang điều tra</small><strong>{data.summary.investigating}</strong></div><em>{data.summary.unassigned} chưa phân công</em></article>
        <article><span className={styles.blueIcon}><TimerOff size={19} /></span><div><small>Quá hạn SLA</small><strong>{data.summary.overdue}</strong></div><em>Cần ưu tiên xử lý</em></article>
        <article><span className={styles.greenIcon}><Target size={19} /></span><div><small>Thời gian xử lý TB</small><strong>{resolutionTime(data.summary.average_resolution_seconds)}</strong></div><em>{data.summary.resolved + data.summary.closed} đã hoàn tất</em></article>
      </section>

      <section className={styles.controlPanel}>
        <div className={styles.statusTabs}>
          {([
            ['all', 'Tất cả', data.summary.total], ['open', 'Mới mở', data.summary.open],
            ['investigating', 'Đang điều tra', data.summary.investigating],
            ['resolved', 'Đã xử lý', data.summary.resolved], ['closed', 'Đã đóng', data.summary.closed],
          ] as const).map(tab => <button key={tab[0]} type="button" className={status === tab[0] ? styles.activeTab : undefined} onClick={() => setStatus(tab[0])}>{tab[1]} <span>{tab[2]}</span></button>)}
          <div className={styles.viewToggle}>
            <button type="button" className={view === 'board' ? styles.activeView : undefined} onClick={() => setView('board')} title="Kanban"><Columns3 size={15} /></button>
            <button type="button" className={view === 'list' ? styles.activeView : undefined} onClick={() => setView('list')} title="Danh sách"><LayoutList size={15} /></button>
          </div>
        </div>
        <div className={styles.filters}>
          <form className={styles.search} onSubmit={event => { event.preventDefault(); setSearch(searchInput.trim()); }}><Search size={15} /><input value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Tìm mã hoặc tiêu đề..." /></form>
          <label><Filter size={14} /><select value={severity} onChange={event => setSeverity(event.target.value as typeof severity)}><option value="all">Mọi mức độ</option><option value="critical">Nghiêm trọng</option><option value="high">Cao</option><option value="medium">Trung bình</option><option value="low">Thấp</option></select><ChevronDown size={12} /></label>
          <label><select value={site} onChange={event => setSite(event.target.value)}><option value="all">Mọi địa điểm</option>{data.filters.sites.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</select><ChevronDown size={12} /></label>
          <label><Users size={14} /><select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">Mọi người phụ trách</option><option value="unassigned">Chưa phân công</option>{data.filters.members.map(member => <option key={member.id} value={member.id}>{member.full_name}</option>)}</select><ChevronDown size={12} /></label>
          <label><CalendarClock size={14} /><select value={period} onChange={event => setPeriod(event.target.value)}><option value="today">Hôm nay</option><option value="7d">7 ngày qua</option><option value="30d">30 ngày qua</option><option value="90d">90 ngày qua</option><option value="all">Toàn bộ</option></select><ChevronDown size={12} /></label>
          <button type="button" onClick={resetFilters}>Đặt lại</button>
        </div>
      </section>

      {error ? (
        <section className={styles.errorState}><span><AlertTriangle size={24} /></span><strong>Không thể tải dữ liệu sự cố</strong><p>{error}</p><button type="button" onClick={() => void loadIncidents()}><RefreshCw size={14} /> Thử lại</button></section>
      ) : view === 'board' ? (
        <section className={styles.board}>
          {columns.map(column => {
            const items = data.items.filter(item => item.status === column.status);
            return <div className={styles.boardColumn} key={column.status}>
              <div className={styles.columnHeading} data-status={column.status}><span><i />{column.title}</span><em>{items.length}</em><small>{column.description}</small></div>
              <div className={styles.columnBody}>
                {loading && !data.items.length ? <div className={styles.columnLoading}><LoaderCircle className={styles.spinning} size={19} /></div> : items.length ? items.map(item => (
                  <button className={selectedId === item.id ? styles.incidentCard + ' ' + styles.selectedCard : styles.incidentCard} type="button" key={item.id} onClick={() => selectIncident(item)}>
                    <div className={styles.cardTop}><span>INC-{String(item.incident_no).padStart(5, '0')}</span><em data-severity={item.severity}>{severityLabels[item.severity]}</em></div>
                    <strong>{item.title}</strong><p>{item.description || 'Chưa có mô tả chi tiết.'}</p>
                    <div className={styles.cardLocation}><MapPin size={11} /> {item.site_name}</div>
                    <div className={styles.cardFooter}>
                      <span className={item.assigned_to ? styles.assigned : styles.unassigned}><User size={11} /> {item.assigned_to?.full_name || 'Chưa phân công'}</span>
                      <span className={item.overdue ? styles.overdue : undefined}><CalendarClock size={11} /> {shortDate(item.due_at)}</span>
                    </div>
                    <div className={styles.cardCounts}><span><ShieldAlert size={11} /> {item.event_count}</span><span><MessageSquare size={11} /> {item.comment_count}</span><span>{relativeTime(item.updated_at)}</span></div>
                  </button>
                )) : <div className={styles.emptyColumn}><CircleDot size={17} /><span>Không có sự cố</span></div>}
              </div>
            </div>;
          })}
        </section>
      ) : (
        <section className={styles.tablePanel}>
          <div className={styles.tableHeader}><strong>Danh sách sự cố</strong><span>{data.total} kết quả</span></div>
          <div className={styles.tableScroll}><table>
            <thead><tr><th>Mã sự cố</th><th>Tiêu đề</th><th>Mức độ</th><th>Trạng thái</th><th>Phụ trách</th><th>Địa điểm</th><th>Hạn xử lý</th><th /></tr></thead>
            <tbody>{data.items.map(item => <tr key={item.id} onClick={() => selectIncident(item)} className={selectedId === item.id ? styles.selectedTableRow : undefined}>
              <td><strong>INC-{String(item.incident_no).padStart(5, '0')}</strong></td><td><span>{item.title}</span><small>{relativeTime(item.opened_at)}</small></td>
              <td><em data-severity={item.severity}>{severityLabels[item.severity]}</em></td><td><i data-status={item.status}>{statusLabels[item.status]}</i></td>
              <td>{item.assigned_to?.full_name || 'Chưa phân công'}</td><td>{item.site_name}</td><td className={item.overdue ? styles.overdueCell : undefined}>{shortDate(item.due_at)}</td><td><ChevronRight size={14} /></td>
            </tr>)}</tbody>
          </table></div>
          {!loading && !data.items.length && <div className={styles.emptyList}><ClipboardCheck size={25} /><strong>Chưa có sự cố phù hợp</strong><p>Thay đổi bộ lọc hoặc tạo hồ sơ sự cố đầu tiên.</p></div>}
        </section>
      )}

      {!error && !loading && !data.items.length && view === 'board' && <section className={styles.zeroState}><span><ClipboardCheck size={28} /></span><strong>Chưa có hồ sơ sự cố</strong><p>Sự cố được tạo thủ công hoặc chuyển từ một cảnh báo đã xác minh. Dữ liệu được lưu trực tiếp vào <code>safety.incidents</code>.</p>{canManage && <button type="button" onClick={openCreate}><Plus size={14} /> Tạo sự cố đầu tiên</button>}</section>}

      {selectedId && <aside className={mobileDetail ? styles.detailDrawer + ' ' + styles.drawerOpen : styles.detailDrawer}>
        {detailLoading && !detail ? <div className={styles.detailLoading}><LoaderCircle className={styles.spinning} size={22} /> Đang tải hồ sơ...</div> : detail && <>
          <div className={styles.drawerHeader}><div><span>INC-{String(detail.incident_no).padStart(5, '0')}</span><em data-status={detail.status}>{statusLabels[detail.status]}</em></div><button type="button" onClick={() => setMobileDetail(false)}><X size={17} /></button></div>
          <div className={styles.drawerTitle}><div><span data-severity={detail.severity}><FileWarning size={20} /></span><div><small>{severityLabels[detail.severity]} · {detail.site_name}</small><h2>{detail.title}</h2><p>Mở {relativeTime(detail.opened_at)} bởi {detail.opened_by?.full_name || 'Hệ thống'}</p></div></div>{canManage && <button type="button" onClick={openEdit}><Pencil size={14} /> Chỉnh sửa</button>}</div>
          <div className={styles.drawerTabs}>
            <button type="button" className={detailTab === 'overview' ? styles.activeDrawerTab : undefined} onClick={() => setDetailTab('overview')}>Tổng quan</button>
            <button type="button" className={detailTab === 'activity' ? styles.activeDrawerTab : undefined} onClick={() => setDetailTab('activity')}>Hoạt động <span>{detail.comments.length + detail.history.length}</span></button>
            <button type="button" className={detailTab === 'alerts' ? styles.activeDrawerTab : undefined} onClick={() => setDetailTab('alerts')}>Cảnh báo nguồn <span>{detail.linked_events.length}</span></button>
          </div>
          <div className={styles.drawerContent}>
            {detailTab === 'overview' && <>
              <section className={styles.infoGrid}><div><small>Người phụ trách</small><strong><UserCheck size={12} /> {detail.assigned_to?.full_name || 'Chưa phân công'}</strong></div><div><small>Hạn xử lý</small><strong className={detail.overdue ? styles.overdueText : undefined}><CalendarClock size={12} /> {fullDate(detail.due_at)}</strong></div><div><small>Địa điểm</small><strong><MapPin size={12} /> {detail.site_name}</strong></div><div><small>Cảnh báo liên kết</small><strong><ShieldAlert size={12} /> {detail.event_count} cảnh báo</strong></div></section>
              <section className={styles.textSection}><strong>Mô tả sự cố</strong><p>{detail.description || 'Chưa có mô tả chi tiết.'}</p></section>
              <section className={styles.remediationGrid}><article><span><Search size={14} /></span><div><strong>Nguyên nhân gốc</strong><p>{detail.root_cause || 'Chưa hoàn tất phân tích nguyên nhân.'}</p></div></article><article><span><Target size={14} /></span><div><strong>Hành động khắc phục</strong><p>{detail.corrective_action || 'Chưa thiết lập hành động khắc phục.'}</p></div></article><article><span><CheckCircle2 size={14} /></span><div><strong>Kết luận xử lý</strong><p>{detail.resolution || 'Chưa có kết luận cuối cùng.'}</p></div></article></section>
              {canManage && nextActions.length > 0 && <section className={styles.workflowActions}><strong>Chuyển trạng thái</strong><div>{nextActions.map(item => <button type="button" key={item.status} onClick={() => { setStatusModal(item.status); setStatusNote(''); }}>{item.label}<ArrowRight size={13} /></button>)}</div></section>}
            </>}
            {detailTab === 'activity' && <section className={styles.activityTab}><div className={styles.timeline}>
              {detail.history.map(item => <article key={'h-' + item.id}><span data-status={item.new_status}><History size={13} /></span><div><strong>Chuyển sang “{statusLabels[item.new_status]}”</strong><small>{item.changed_by?.full_name || 'Hệ thống'} · {fullDate(item.changed_at)}</small>{item.note && <p>{item.note}</p>}</div></article>)}
              {detail.comments.map(item => <article key={'c-' + item.id}><span><MessageSquare size={13} /></span><div><strong>{item.user?.full_name || 'Người dùng'} đã bình luận</strong><small>{fullDate(item.created_at)}</small><p>{item.body}</p></div></article>)}
              {!detail.history.length && !detail.comments.length && <div className={styles.noActivity}>Chưa có hoạt động trong hồ sơ.</div>}
            </div>{canManage && <form className={styles.commentForm} onSubmit={addComment}><textarea value={comment} onChange={event => setComment(event.target.value)} placeholder="Thêm cập nhật hoặc ghi chú điều tra..." /><button type="submit" disabled={busy || !comment.trim()}><Send size={14} /> Gửi bình luận</button></form>}</section>}
            {detailTab === 'alerts' && <section className={styles.linkedAlerts}>{detail.linked_events.length ? detail.linked_events.map(item => <article key={item.id}><span data-severity={item.severity}><Siren size={15} /></span><div><strong>{item.title}</strong><small>{item.event_name} · {item.camera_code} · {fullDate(item.detected_at)}</small></div><em>{severityLabels[item.severity]}</em></article>) : <div className={styles.noActivity}>Sự cố này chưa liên kết cảnh báo nguồn.</div>}</section>}
          </div>
        </>}
      </aside>}

      {editorMode && <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setEditorMode(null); }}><form className={styles.editorModal} onSubmit={submitEditor}>
        <div className={styles.modalHeading}><span><FileWarning size={19} /></span><div><strong>{editorMode === 'create' ? 'Tạo hồ sơ sự cố' : 'Cập nhật hồ sơ sự cố'}</strong><small>{editorMode === 'create' ? 'Ghi nhận và phân công xử lý' : 'Bổ sung kết quả điều tra và khắc phục'}</small></div><button type="button" onClick={() => setEditorMode(null)}><X size={16} /></button></div>
        {editorMode === 'create' && !data.filters.sites.length && <div className={styles.formWarning}><AlertTriangle size={15} /><span>Chưa có địa điểm hoạt động. Hãy tạo site trong module Camera & khu vực trước.</span></div>}
        <div className={styles.formGrid}>
          <label className={styles.wide}><span>Tiêu đề sự cố *</span><input required minLength={3} value={editor.title} onChange={event => setEditor(current => ({ ...current, title: event.target.value }))} placeholder="Mô tả ngắn gọn sự cố..." /></label>
          {editorMode === 'create' && <label><span>Địa điểm *</span><select required value={editor.site_code} onChange={event => setEditor(current => ({ ...current, site_code: event.target.value }))}><option value="">Chọn địa điểm</option>{data.filters.sites.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</select></label>}
          <label><span>Mức độ</span><select value={editor.severity} onChange={event => setEditor(current => ({ ...current, severity: event.target.value as Severity }))}><option value="low">Thấp</option><option value="medium">Trung bình</option><option value="high">Cao</option><option value="critical">Nghiêm trọng</option></select></label>
          <label><span>Người phụ trách</span><select value={editor.assigned_to} onChange={event => setEditor(current => ({ ...current, assigned_to: event.target.value }))}><option value="">Chưa phân công</option>{data.filters.members.map(member => <option key={member.id} value={member.id}>{member.full_name}</option>)}</select></label>
          <label><span>Hạn xử lý</span><input type="datetime-local" value={editor.due_at} onChange={event => setEditor(current => ({ ...current, due_at: event.target.value }))} /></label>
          <label className={styles.wide}><span>Mô tả chi tiết</span><textarea value={editor.description} onChange={event => setEditor(current => ({ ...current, description: event.target.value }))} placeholder="Hiện tượng, phạm vi ảnh hưởng và tình trạng ban đầu..." /></label>
          {editorMode === 'edit' && <><label className={styles.wide}><span>Nguyên nhân gốc</span><textarea value={editor.root_cause} onChange={event => setEditor(current => ({ ...current, root_cause: event.target.value }))} /></label><label className={styles.wide}><span>Hành động khắc phục</span><textarea value={editor.corrective_action} onChange={event => setEditor(current => ({ ...current, corrective_action: event.target.value }))} /></label><label className={styles.wide}><span>Kết luận xử lý</span><textarea value={editor.resolution} onChange={event => setEditor(current => ({ ...current, resolution: event.target.value }))} /></label></>}
        </div>
        <div className={styles.modalActions}><button type="button" onClick={() => setEditorMode(null)}>Hủy</button><button type="submit" disabled={busy || (editorMode === 'create' && !data.filters.sites.length)}>{busy ? <LoaderCircle className={styles.spinning} size={14} /> : <Check size={14} />} {editorMode === 'create' ? 'Tạo sự cố' : 'Lưu thay đổi'}</button></div>
      </form></div>}

      {statusModal && detail && <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setStatusModal(null); }}><form className={styles.statusModal} onSubmit={changeStatus}>
        <div className={styles.modalHeading}><span><Activity size={19} /></span><div><strong>Chuyển sang “{statusLabels[statusModal]}”</strong><small>INC-{String(detail.incident_no).padStart(5, '0')} · {detail.title}</small></div><button type="button" onClick={() => setStatusModal(null)}><X size={16} /></button></div>
        <label><span>Ghi chú chuyển trạng thái {['resolved', 'closed'].includes(statusModal) && '*'}</span><textarea value={statusNote} onChange={event => setStatusNote(event.target.value)} required={['resolved', 'closed'].includes(statusModal)} placeholder="Nêu hành động đã thực hiện hoặc lý do chuyển trạng thái..." /></label>
        <div className={styles.modalActions}><button type="button" onClick={() => setStatusModal(null)}>Hủy</button><button type="submit" disabled={busy}>{busy ? <LoaderCircle className={styles.spinning} size={14} /> : <Check size={14} />} Xác nhận</button></div>
      </form></div>}
    </div>
  );
}

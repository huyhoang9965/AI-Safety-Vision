'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, CheckCheck, Clock3, FilePlus2, Loader2, Search, Send, ShieldCheck, X } from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/auth';
import { categoryLabels, messagingApi, priorityLabels, statusLabels, type Contact, type RequestStatus, type TeamRequest } from '@/lib/messaging';
import styles from './team-messaging.module.css';

export const formatDate = (date: string | null, full = false) => date
  ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', ...(full ? { year: 'numeric' as const } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(date)) : 'Không đặt hạn';
export const requestCode = (request: TeamRequest) => `YC-${String(request.request_no).padStart(4, '0')}`;
export const isOverdue = (request: TeamRequest) => !!request.due_at && new Date(request.due_at).getTime() < Date.now() && ['pending', 'in_progress'].includes(request.status);

export function Avatar({ contact }: { contact: Pick<Contact, 'full_name' | 'avatar_url'> & { role_code?: string } }) {
  const admin = ['org_admin', 'super_admin'].includes(contact.role_code || '');
  return <span className={`${styles.avatar} ${admin ? styles.adminAvatar : styles.operatorAvatar}`} aria-hidden="true">
    {contact.avatar_url ? <img src={resolveAvatarUrl(contact.avatar_url)} alt="" /> : contact.full_name.split(/\s+/).filter(Boolean).slice(-2).map(word => word[0]).join('').toUpperCase()}
  </span>;
}

export function Status({ value }: { value: RequestStatus }) {
  return <span className={`${styles.status} ${styles[value]}`}>{value === 'completed' ? <CheckCheck size={11} /> : value === 'in_progress' ? <Loader2 size={11} /> : <Clock3 size={11} />}{statusLabels[value]}</span>;
}

export function Priority({ value }: { value: TeamRequest['priority'] }) {
  return <span className={`${styles.priority} ${styles[value]}`}>{priorityLabels[value]}</span>;
}

export function Modal({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === ref.current && !busy) { const box = ref.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
    <div className={styles.dialogHead}><h2 id={titleId}>{title}</h2><button type="button" className={styles.iconButton} aria-label="Đóng hộp thoại" onClick={onClose} disabled={busy}><X size={17} /></button></div>
    <div className={styles.dialogContent}>{children}</div>
  </dialog>;
}

export function NewConversation({ contacts, onChoose, onClose }: { contacts: Contact[]; onChoose: (contact: Contact) => Promise<void>; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filtered = contacts.filter(contact => `${contact.full_name} ${contact.role_name} ${contact.department || ''}`.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')));
  return <Modal title="Bắt đầu cuộc trò chuyện" busy={busy} onClose={onClose}>
    <p className={styles.hint}>Chọn quản trị viên hoặc đồng nghiệp trong tổ chức để trao đổi và gửi yêu cầu.</p>
    <label className={styles.search}><Search size={16} /><input autoFocus aria-label="Tìm người nhận" placeholder="Tìm tên, vai trò, bộ phận..." value={search} onChange={event => setSearch(event.target.value)} /></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.contactList}>{filtered.map(contact => <button key={contact.id} className={styles.contact} disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await onChoose(contact); } catch (error) { setError(error instanceof Error ? error.message : 'Không thể mở hội thoại.'); setBusy(false); }
    }}><Avatar contact={contact} /><span><strong>{contact.full_name}</strong><small>{contact.role_name}{contact.department ? ` · ${contact.department}` : ''}</small></span>{busy ? <Loader2 size={15} className={styles.spinning} /> : <ArrowRight size={15} />}</button>)}</div>
    {!filtered.length && <div className={styles.empty}><Search size={24} /><strong>{contacts.length ? 'Không tìm thấy người nhận' : 'Chưa có người nhận phù hợp'}</strong><p>{contacts.length ? 'Thử tìm theo tên hoặc bộ phận khác.' : 'Thành viên cần có quyền Tin nhắn & yêu cầu và đang hoạt động trong cùng tổ chức.'}</p></div>}
  </Modal>;
}

export function RequestForm({ contact, conversationId, onSent, onClose }: { contact: Contact; conversationId: string; onSent: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ payload: string; clientId: string } | null>(null);
  return <Modal title="Tạo yêu cầu mới" busy={busy} onClose={onClose}>
    <form className={styles.form} onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const due = String(data.get('due_at') || '');
      if (due && new Date(due).getTime() <= Date.now()) { setError('Hạn xử lý cần ở tương lai.'); return; }
      const body = { title: String(data.get('title')).trim(), description: String(data.get('description')).trim(),
        category: data.get('category'), priority: data.get('priority'), due_at: due ? new Date(due).toISOString() : null };
      if (!body.title || !body.description) { setError('Vui lòng nhập tiêu đề và nội dung yêu cầu.'); return; }
      const payload = JSON.stringify(body);
      if (retry.current?.payload !== payload) retry.current = { payload, clientId: crypto.randomUUID() };
      setBusy(true); setError('');
      try {
        await messagingApi(`/conversations/${conversationId}/requests`, { body: { ...body, client_id: retry.current.clientId } });
        onSent();
      } catch (error) { setError(error instanceof Error ? error.message : 'Chưa gửi được yêu cầu.'); setBusy(false); }
    }}>
      <div className={styles.recipient}><Avatar contact={contact} /><div><small>Gửi yêu cầu đến</small><strong>{contact.full_name}</strong></div></div>
      <label>Tiêu đề yêu cầu *<input name="title" autoFocus placeholder="Ví dụ: Kiểm tra camera tại khu vực kho A" maxLength={160} required disabled={busy} /></label>
      <div className={styles.formGrid}>
        <label>Loại yêu cầu<select name="category" disabled={busy}>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Mức ưu tiên<select name="priority" disabled={busy}>{Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <label>Nội dung yêu cầu *<textarea name="description" placeholder="Mô tả tình huống, khu vực và việc cần hỗ trợ..." maxLength={5000} rows={4} required disabled={busy} /></label>
      <label>Hạn xử lý (không bắt buộc)<input name="due_at" type="datetime-local" disabled={busy} /></label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p className={styles.hint}>Người nhận có thể tiếp nhận hoặc từ chối. Mọi thay đổi trạng thái được ghi lại trong hội thoại.</p>
      <div className={styles.formFooter}><button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>Hủy</button><button className={styles.primary} disabled={busy}>{busy ? <Loader2 size={15} className={styles.spinning} /> : <Send size={15} />}{busy ? 'Đang gửi...' : 'Gửi yêu cầu'}</button></div>
    </form>
  </Modal>;
}

export function RequestDetail({ request, userId, onClose, onUpdated, onOpenConversation }: { request: TeamRequest; userId: string; onClose: () => void; onUpdated: (request: TeamRequest) => void; onOpenConversation: () => void }) {
  const [action, setAction] = useState<RequestStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const recipient = request.recipient_id === userId;
  const open = ['pending', 'in_progress'].includes(request.status);
  const actionLabels: Partial<Record<RequestStatus, string>> = { in_progress: 'Tiếp nhận yêu cầu', completed: 'Xác nhận hoàn thành', rejected: 'Từ chối yêu cầu', cancelled: 'Hủy yêu cầu' };
  return <Modal title={`Chi tiết yêu cầu · ${requestCode(request)}`} busy={busy} onClose={onClose}>
    <div className={styles.requestDetail}>
      <div className={styles.tags}><Status value={request.status} /><Priority value={request.priority} /></div>
      <h3>{request.title}</h3><p className={styles.description}>{request.description}</p>
      <div className={styles.detailMeta}>
        <div><small>Người gửi</small><span>{request.sender_name || (recipient ? 'Đồng nghiệp' : 'Bạn')}</span></div>
        <div><small>Người nhận</small><span>{request.recipient_name || (recipient ? 'Bạn' : 'Đồng nghiệp')}</span></div>
        <div><small>Loại yêu cầu</small><span>{categoryLabels[request.category]}</span></div>
        <div><small>Hạn xử lý</small><span className={isOverdue(request) ? styles.overdue : ''}>{formatDate(request.due_at, true)}{isOverdue(request) ? ' · Quá hạn' : ''}</span></div>
        <div><small>Ngày tạo</small><span>{formatDate(request.created_at, true)}</span></div>
        <div><small>Cập nhật gần nhất</small><span>{formatDate(request.updated_at, true)}</span></div>
      </div>
      {request.resolution_note && <div><p className={styles.hint}>Ghi chú xử lý</p><p className={styles.description}>{request.resolution_note}</p></div>}
      {action && open ? <form className={styles.form} onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try {
          const updated = await messagingApi<TeamRequest>(`/requests/${request.id}/status`, { body: { status: action, note } });
          onUpdated({ ...request, ...updated }); setAction(null); setNote('');
        } catch (error) { setError(error instanceof Error ? error.message : 'Không thể cập nhật yêu cầu.'); }
        finally { setBusy(false); }
      }}>
        <label>{action === 'rejected' ? 'Lý do từ chối *' : 'Ghi chú xử lý (không bắt buộc)'}<textarea autoFocus value={note} onChange={event => setNote(event.target.value)} maxLength={2000} required={action === 'rejected'} disabled={busy} /></label>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.formFooter}><button type="button" className={styles.secondary} onClick={() => { setAction(null); setError(''); }} disabled={busy}>Quay lại</button><button className={action === 'rejected' || action === 'cancelled' ? styles.danger : styles.primary} disabled={busy || (action === 'rejected' && !note.trim())}>{busy ? <Loader2 size={15} className={styles.spinning} /> : <Check size={15} />}{actionLabels[action]}</button></div>
      </form> : <div className={styles.actions}>
        {recipient && request.status === 'pending' && <><button className={styles.primary} onClick={() => setAction('in_progress')}><ShieldCheck size={15} />Tiếp nhận</button><button className={styles.danger} onClick={() => setAction('rejected')}>Từ chối</button></>}
        {recipient && request.status === 'in_progress' && <button className={styles.primary} onClick={() => setAction('completed')}><CheckCheck size={15} />Hoàn thành</button>}
        {!recipient && open && <button className={styles.danger} onClick={() => setAction('cancelled')}>Hủy yêu cầu</button>}
        <button className={styles.secondary} onClick={onOpenConversation}><FilePlus2 size={14} />Mở hội thoại</button>
      </div>}
    </div>
  </Modal>;
}

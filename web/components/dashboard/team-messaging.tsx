'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronRight, ClipboardList, Clock3, FilePlus2, Inbox, Info, Loader2, MessageSquare, MessageSquarePlus, RefreshCw, Search, Send, ShieldCheck, Users, X } from 'lucide-react';
import { type ApiMembership, type ApiUser } from '@/lib/auth';
import { messagingApi, notifyMessagingUpdated, statusLabels, type Contact, type MessagePage, type MessagingOverview, type TeamRequest } from '@/lib/messaging';
import { useDashboardAccount } from './dashboard-account';
import { Avatar, formatDate, isOverdue, NewConversation, Priority, RequestDetail, RequestForm, requestCode, Status } from './team-messaging-dialogs';
import styles from './team-messaging.module.css';

const shortTime = (value: string) => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const dayLabel = (value: string) => {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? 'Hôm nay' : new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
};
const inboxTime = (value: string | null) => !value ? '' : new Date(value).toDateString() === new Date().toDateString() ? shortTime(value) : new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(new Date(value));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Không thể tải tin nhắn. Vui lòng thử lại.';

export default function TeamMessaging() {
  const user = useDashboardAccount();
  const memberships = user.memberships.filter(item => item.permissions.includes('messaging.use'));
  const [chosenOrg, setChosenOrg] = useState('');
  const organization = memberships.find(item => item.organization_id === chosenOrg) || memberships.find(item => item.is_default) || memberships[0];
  if (!organization) return <div className={styles.empty}><ShieldCheck size={32} /><strong>Tài khoản chưa có quyền sử dụng tin nhắn</strong><p>Liên hệ quản trị viên để được cấp quyền trao đổi nội bộ.</p><Link href="/dashboard/profile" className={styles.secondary}>Hồ sơ cá nhân</Link></div>;
  return <MessagingWorkspace key={`${user.id}:${organization.organization_id}`} user={user} organization={organization} memberships={memberships} onOrganization={setChosenOrg} />;
}

function MessagingWorkspace({ user, organization, memberships, onOrganization }: { user: ApiUser; organization: ApiMembership; memberships: ApiMembership[]; onOrganization: (id: string) => void }) {
  const [data, setData] = useState<MessagingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');
  const [chatError, setChatError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<'messages' | 'requests'>('messages');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mobileChat, setMobileChat] = useState(false);
  const [details, setDetails] = useState(false);
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [newConversation, setNewConversation] = useState<false | 'message' | 'request'>(false);
  const [newRequest, setNewRequest] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<TeamRequest | null>(null);
  const [messages, setMessages] = useState<MessagePage | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [requestSearch, setRequestSearch] = useState('');
  const [requestDirection, setRequestDirection] = useState('all');
  const [requestStatus, setRequestStatus] = useState('all');
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef(activeId);
  const initialSelection = useRef(false);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const readCursor = useRef<Record<string, number>>({});
  const sendRetry = useRef<Record<string, { content: string; clientId: string }>>({});
  activeRef.current = activeId;
  const active = data?.conversations.find(item => item.id === activeId);
  const contact = data?.contacts.find(item => item.id === active?.partner_id);
  const activeRequests = data?.requests.filter(item => item.conversation_id === activeId) || [];
  const currentRequest = selectedRequest ? data?.requests.find(item => item.id === selectedRequest.id) || selectedRequest : null;
  const draft = activeId ? drafts[activeId] || '' : '';

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const payload = await messagingApi<MessagingOverview>(`/overview?organization_id=${organization.organization_id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(payload); setOverviewError(''); setLastSync(new Date().toISOString());
        if (!initialSelection.current) {
          initialSelection.current = true;
          if (payload.conversations[0]) setActiveId(payload.conversations[0].id);
        } else if (activeRef.current && !payload.conversations.some(item => item.id === activeRef.current)) {
          setActiveId(null); setMobileChat(false); setNewRequest(false); setSelectedRequest(null);
        }
      } catch (error) { if (!controller.signal.aborted) setOverviewError(errorMessage(error)); }
      finally { if (!controller.signal.aborted) { setLoading(false); pending = false; } }
    }
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [organization.organization_id, tick]);

  useEffect(() => {
    setMessages(null); setChatError(''); setMessagesLoading(!!activeId);
    stickToBottom.current = true;
    setAtBottom(true);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const payload = await messagingApi<MessagePage>(`/conversations/${id}/messages`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setMessages(previous => {
          if (!previous) return payload;
          const merged = new Map([...previous.items, ...payload.items].map(item => [item.id, item]));
          return { ...payload, items: [...merged.values()].sort((a, b) => a.id - b.id),
            has_more: previous.items[0]?.id < (payload.items[0]?.id ?? Infinity) ? previous.has_more : payload.has_more };
        });
        setChatError('');
      } catch (error) { if (!controller.signal.aborted) setChatError(errorMessage(error)); }
      finally { if (!controller.signal.aborted) { pending = false; setMessagesLoading(false); } }
    }
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [activeId, tick]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (restoreScroll.current) {
      list.scrollTop = restoreScroll.current.top + list.scrollHeight - restoreScroll.current.height;
      restoreScroll.current = null;
    } else if (stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages, mobileChat, tab]);

  useEffect(() => {
    const lastId = messages?.items.at(-1)?.id;
    if (!activeId || !lastId || !atBottom || tab !== 'messages' || document.visibilityState !== 'visible'
      || (window.matchMedia('(max-width: 700px)').matches && !mobileChat) || (readCursor.current[activeId] || 0) >= lastId) return;
    const id = activeId;
    const controller = new AbortController();
    void messagingApi(`/conversations/${id}/read`, { body: { through_id: lastId }, signal: controller.signal }).then(() => {
      if (controller.signal.aborted) return;
      readCursor.current[id] = lastId;
      setData(previous => {
        if (!previous) return previous;
        const count = previous.conversations.find(item => item.id === id)?.unread_count || 0;
        return { ...previous, conversations: previous.conversations.map(item => item.id === id ? { ...item, unread_count: 0 } : item), summary: { ...previous.summary, unread: Math.max(0, previous.summary.unread - count) } };
      });
      notifyMessagingUpdated();
    }).catch(() => { /* A failed receipt is retried on the next refresh; never show an unconfirmed read state. */ });
    return () => controller.abort();
  }, [messages, activeId, mobileChat, tab, atBottom]);

  function chooseConversation(id: string) {
    setActiveId(id); setMobileChat(true); setTab('messages'); setDetails(false); setNotice('');
  }

  function beginRequest() {
    if (activeId && contact) setNewRequest(true); else setNewConversation('request');
  }

  async function chooseContact(person: Contact) {
    const result = await messagingApi<{ id: string }>('/conversations', { body: { organization_id: organization.organization_id, recipient_id: person.id } });
    const payload = await messagingApi<MessagingOverview>(`/overview?organization_id=${organization.organization_id}`);
    setData(payload); chooseConversation(result.id);
    if (newConversation === 'request') setNewRequest(true);
    setNewConversation(false); notifyMessagingUpdated();
  }

  async function sendMessage() {
    if (!activeId || !draft.trim() || sending || !contact) return;
    const id = activeId, content = draft.trim();
    if (sendRetry.current[id]?.content !== content) sendRetry.current[id] = { content, clientId: crypto.randomUUID() };
    setSending(true); setChatError('');
    try {
      await messagingApi(`/conversations/${id}/messages`, { body: { content, client_id: sendRetry.current[id].clientId } });
      setDrafts(previous => previous[id]?.trim() === content ? { ...previous, [id]: '' } : previous);
      delete sendRetry.current[id];
      if (activeRef.current === id) { stickToBottom.current = true; composerRef.current?.focus(); }
      setTick(value => value + 1); notifyMessagingUpdated();
    } catch (error) { if (activeRef.current === id) setChatError(errorMessage(error)); }
    finally { setSending(false); }
  }

  async function loadOlder() {
    if (!activeId || !messages?.items.length || olderLoading) return;
    const id = activeId;
    setOlderLoading(true);
    try {
      const payload = await messagingApi<MessagePage>(`/conversations/${id}/messages?before=${messages.items[0].id}`);
      if (activeRef.current !== id) return;
      if (listRef.current) restoreScroll.current = { height: listRef.current.scrollHeight, top: listRef.current.scrollTop };
      setMessages(previous => previous ? { ...previous, has_more: payload.has_more,
        items: [...new Map([...payload.items, ...previous.items].map(item => [item.id, item])).values()].sort((a, b) => a.id - b.id) } : payload);
    } catch (error) { if (activeRef.current === id) setChatError(errorMessage(error)); }
    finally { setOlderLoading(false); }
  }

  const filteredConversations = data?.conversations.filter(item => {
    const person = data.contacts.find(contact => contact.id === item.partner_id);
    return (!unreadOnly || item.unread_count > 0) && `${person?.full_name} ${person?.role_name} ${item.last_message || ''}`.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi'));
  }) || [];
  const filteredRequests = data?.requests.filter(item => (requestDirection === 'all' || (requestDirection === 'received' ? item.recipient_id === user.id : item.sender_id === user.id))
    && (requestStatus === 'all' || (requestStatus === 'overdue' ? isOverdue(item) : item.status === requestStatus))
    && `${requestCode(item)} ${item.title} ${item.sender_name} ${item.recipient_name}`.toLocaleLowerCase('vi').includes(requestSearch.toLocaleLowerCase('vi'))) || [];
  const summary = data?.summary;

  function requestCard(request: TeamRequest) {
    const latest = data?.requests.find(item => item.id === request.id) || request;
    return <article className={styles.requestCard}>
      <div className={styles.requestCardHeader}><ClipboardList size={13} /><span>YÊU CẦU CÔNG VIỆC</span><span style={{ marginLeft: 'auto' }}>{requestCode(latest)}</span></div>
      <div className={styles.requestCardContent}><h3>{latest.title}</h3><p>{latest.description}</p>
        <div className={styles.tags}><Status value={latest.status} /><Priority value={latest.priority} /></div>
        {latest.due_at && <span className={`${styles.deadline} ${isOverdue(latest) ? styles.overdue : ''}`}><Clock3 size={12} />{isOverdue(latest) ? 'Quá hạn · ' : 'Hạn xử lý · '}{formatDate(latest.due_at)}</span>}
        <div className={styles.cardActions}><button className={latest.recipient_id === user.id && latest.status === 'pending' ? styles.primary : styles.secondary} onClick={() => setSelectedRequest(latest)}>{latest.recipient_id === user.id && latest.status === 'pending' ? 'Xem & tiếp nhận' : 'Xem chi tiết'}<ArrowUpRight size={12} /></button></div>
      </div>
    </article>;
  }

  return <div className={styles.page}>
    <div className={styles.heading}><div><span className={styles.eyebrow}><Users size={13} />KẾT NỐI ĐỘI NGŨ</span><h1>Tin nhắn & yêu cầu</h1><p>Trao đổi kịp thời. Phối hợp xử lý. Giữ an toàn cùng nhau.</p></div>
      <div className={styles.actions}>
        {memberships.length > 1 && <select className={styles.orgSelect} aria-label="Tổ chức trao đổi" value={organization.organization_id} onChange={event => onOrganization(event.target.value)}>{memberships.map(item => <option key={item.organization_id} value={item.organization_id}>{item.organization_name}</option>)}</select>}
        <button className={styles.secondary} onClick={beginRequest} disabled={!data}><FilePlus2 size={15} />Tạo yêu cầu</button>
        <button className={styles.primary} onClick={() => setNewConversation('message')} disabled={!data}><MessageSquarePlus size={15} />Tin nhắn mới</button>
      </div>
    </div>
    <div className={styles.stats}>
      {[{ label: 'Tin nhắn chưa đọc', value: summary?.unread, icon: MessageSquare }, { label: 'Yêu cầu chờ bạn tiếp nhận', value: summary?.pending, icon: Inbox }, { label: 'Yêu cầu đang xử lý', value: summary?.in_progress, icon: Clock3 }, { label: 'Yêu cầu đã hoàn thành', value: summary?.completed, icon: CheckCheck }].map(item => <div key={item.label} className={styles.stat}><span className={styles.statIcon}><item.icon size={20} /></span><div><strong>{item.value ?? '—'}</strong><small>{item.label}</small></div></div>)}
    </div>
    <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label="Nội dung trao đổi" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'messages' : event.key === 'End' ? 'requests' : tab === 'messages' ? 'requests' : 'messages';
      setTab(next); document.getElementById(`${next}-tab`)?.focus();
    }}>
      <button role="tab" id="messages-tab" aria-controls="messages-panel" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}><MessageSquare size={15} />Hội thoại{summary && summary.unread > 0 && <span className={styles.count}>{summary.unread}</span>}</button>
      <button role="tab" id="requests-tab" aria-controls="requests-panel" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}><ClipboardList size={15} />Yêu cầu<span className={styles.count}>{summary?.requests_total ?? 0}</span></button>
    </div><div className={styles.sync}>{lastSync && !overviewError && <><i /><span>Cập nhật lúc {shortTime(lastSync)}</span></>}<button className={styles.iconButton} aria-label="Tải lại tin nhắn và yêu cầu" onClick={() => setTick(value => value + 1)}><RefreshCw size={14} className={loading ? styles.spinning : ''} /></button></div></div>
    {overviewError && <div className={styles.error} role="alert"><p>{overviewError} {data ? 'Dữ liệu đang hiển thị có thể chưa cập nhật.' : ''}</p><button className={styles.subtle} onClick={() => setTick(value => value + 1)}>Thử lại</button></div>}
    {notice && <p role="status" className={styles.hint}>{notice}</p>}

    {tab === 'messages' ? <div id="messages-panel" role="tabpanel" aria-labelledby="messages-tab" className={`${styles.workspace} ${details && contact ? styles.withDetails : ''} ${mobileChat ? styles.mobileChat : ''}`}>
      <aside className={styles.inbox} aria-label="Danh sách hội thoại">
        <div className={styles.inboxHead}><div className={styles.sectionTitle}><h2>Hộp thư <span className={styles.count}>{data?.conversations.length ?? 0}</span></h2><button className={styles.iconButton} aria-label="Bắt đầu hội thoại mới" disabled={!data} onClick={() => setNewConversation('message')}><MessageSquarePlus size={15} /></button></div>
          <label className={styles.search}><Search size={15} /><input aria-label="Tìm hội thoại" placeholder="Tìm tên hoặc tin nhắn..." value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className={styles.inboxFilters}><button aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>Tất cả</button><button aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Chưa đọc{summary?.unread ? ` (${summary.unread})` : ''}</button></div>
        </div>
        <div className={styles.conversationList}>
          {loading && !data ? <div className={styles.empty} role="status"><Loader2 className={styles.spinning} size={24} /><p>Đang tải hộp thư...</p></div> : filteredConversations.map(item => {
            const person = data!.contacts.find(contact => contact.id === item.partner_id)!;
            return <button key={item.id} className={styles.conversation} aria-current={item.id === activeId} onClick={() => chooseConversation(item.id)}>
              <Avatar contact={person} /><span className={styles.conversationText}><span><strong>{person.full_name}</strong><time>{inboxTime(item.last_message_at)}</time></span><small>{person.role_name}</small><span><span className={styles.preview}>{item.last_kind === 'request' ? '📋 ' : ''}{item.last_message || 'Bắt đầu trao đổi công việc'}</span>{item.unread_count > 0 && <em className={styles.unread}>{item.unread_count}</em>}</span></span>
            </button>;
          })}
          {!loading && !filteredConversations.length && <div className={styles.empty}><Inbox size={28} /><strong>{search || unreadOnly ? 'Không có hội thoại phù hợp' : 'Hộp thư của bạn đã sẵn sàng'}</strong><p>{search || unreadOnly ? 'Thử đổi bộ lọc hoặc từ khóa tìm kiếm.' : 'Bắt đầu cuộc trò chuyện đầu tiên với đội ngũ của bạn.'}</p>{!search && !unreadOnly && <button className={styles.secondary} onClick={() => setNewConversation('message')} disabled={!data}>Chọn người nhận</button>}</div>}
        </div><p className={styles.inboxFooter}><ShieldCheck size={13} />Chỉ người tham gia được xem hội thoại</p>
      </aside>
      <section className={styles.chat} aria-label="Nội dung hội thoại">
        {active && contact ? <>
          <header className={styles.chatHeader}><button className={`${styles.iconButton} ${styles.mobileBack}`} aria-label="Quay lại danh sách hội thoại" onClick={() => { setMobileChat(false); setDetails(false); }}><ArrowLeft size={16} /></button><Avatar contact={contact} /><div className={styles.chatPerson}><strong>{contact.full_name}</strong><small>{contact.department || contact.role_name}</small></div><span className={styles.role}>{contact.role_name}</span><button className={styles.iconButton} aria-label="Thông tin hội thoại" aria-expanded={details} onClick={() => setDetails(value => !value)}><Info size={17} /></button></header>
          <div className={styles.messages} ref={listRef} role="log" aria-label="Tin nhắn trong hội thoại" aria-live="polite" aria-busy={messagesLoading} onScroll={() => { const list = listRef.current; if (list) { stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80; setAtBottom(stickToBottom.current); } }}>
            {messagesLoading && <div className={styles.empty} role="status"><Loader2 size={24} className={styles.spinning} /><p>Đang tải cuộc trò chuyện...</p></div>}
            {messages?.has_more && <div style={{ textAlign: 'center', marginBottom: 16 }}><button className={styles.secondary} onClick={loadOlder} disabled={olderLoading}>{olderLoading ? 'Đang tải...' : 'Xem tin nhắn trước đó'}</button></div>}
            {messages && !messages.items.length && <div className={styles.empty}><span className={styles.emptyIcon}><MessageSquare size={27} /></span><strong>Bắt đầu trao đổi với {contact.full_name}</strong><p>Gửi lời nhắn hoặc tạo một yêu cầu để phối hợp công việc.</p></div>}
            {messages?.items.map((message, index) => {
              const own = message.sender_id === user.id;
              const showDay = index === 0 || dayLabel(messages.items[index - 1].created_at) !== dayLabel(message.created_at);
              return <Fragment key={message.id}>{showDay && <div className={styles.day}>{dayLabel(message.created_at)}</div>}
                {message.kind === 'activity' ? <p className={styles.activity}><Check size={12} />{message.content}</p> : <div className={`${styles.message} ${own ? styles.ownMessage : ''}`}>
                  {!own && <Avatar contact={contact} />}<div className={styles.messageBody}>{message.kind === 'request' && message.request ? requestCard(message.request) : <div className={styles.bubble}>{message.content}</div>}<div className={styles.messageMeta}><time dateTime={message.created_at}>{shortTime(message.created_at)}</time>{own && <>{messages.partner_read_id >= message.id ? <><CheckCheck size={12} className={styles.read} /><span>Đã đọc</span></> : <><Check size={12} /><span>Đã gửi</span></>}</>}</div></div>
                </div>}
              </Fragment>;
            })}
          </div>
          <form className={styles.composer} onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
            {chatError && <div className={styles.error} role="alert"><p>{chatError}</p><button type="button" className={styles.subtle} onClick={() => setTick(value => value + 1)}>Tải lại</button></div>}
            <div className={styles.quickActions}><button type="button" onClick={() => setNewRequest(true)}><FilePlus2 size={12} />Tạo yêu cầu công việc</button><button type="button" onClick={() => { setDrafts(previous => ({ ...previous, [active.id]: 'Tôi đã nhận thông tin và sẽ kiểm tra ngay.' })); composerRef.current?.focus(); }}>Đã nhận thông tin</button></div>
            <div className={styles.inputBox}><textarea ref={composerRef} aria-label="Nội dung tin nhắn" placeholder={`Nhắn tin cho ${contact.full_name}...`} value={draft} maxLength={5000} rows={2} onChange={event => setDrafts(previous => ({ ...previous, [active.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} /><button className={styles.send} aria-label="Gửi tin nhắn" disabled={!draft.trim() || sending}>{sending ? <Loader2 size={17} className={styles.spinning} /> : <Send size={17} />}</button></div>
            <div className={styles.composerFooter}><span>Enter để gửi · Shift + Enter để xuống dòng</span><span>{draft.length}/5.000</span></div>
          </form>
        </> : <div className={styles.empty}><span className={styles.emptyIcon}><MessageSquare size={30} /></span><strong>Kết nối để phối hợp tốt hơn</strong><p>Chọn một hội thoại hoặc bắt đầu trao đổi với quản trị viên và nhân viên giám sát.</p><button className={styles.primary} disabled={!data} onClick={() => setNewConversation('message')}><MessageSquarePlus size={15} />Bắt đầu trò chuyện</button></div>}
      </section>
      {details && contact && <aside className={styles.details} aria-label="Thông tin cuộc trò chuyện"><div className={styles.sectionTitle}><h2>Thông tin hội thoại</h2><button className={styles.iconButton} aria-label="Đóng thông tin hội thoại" onClick={() => setDetails(false)}><X size={15} /></button></div>
        <div className={styles.personCard}><Avatar contact={contact} /><strong>{contact.full_name}</strong><span className={styles.role}>{contact.role_name}</span><small>{contact.department || 'Thành viên trong tổ chức'}</small></div>
        <div className={styles.detailSection}><h3><Users size={13} />Thông tin làm việc</h3><dl><div><dt>Tổ chức</dt><dd>{organization.organization_name}</dd></div><div><dt>Bộ phận</dt><dd>{contact.department || 'Chưa cập nhật'}</dd></div><div><dt>Chức danh</dt><dd>{contact.job_title || contact.role_name}</dd></div></dl></div>
        <div className={styles.detailSection}><h3><ClipboardList size={13} />Yêu cầu đang mở <span className={styles.count}>{activeRequests.filter(item => ['pending', 'in_progress'].includes(item.status)).length}</span></h3>
          {activeRequests.filter(item => ['pending', 'in_progress'].includes(item.status)).slice(0, 5).map(request => <button key={request.id} className={styles.requestMini} onClick={() => setSelectedRequest(request)}><small>{requestCode(request)}</small><strong>{request.title}</strong><div className={styles.tags}><Status value={request.status} /></div></button>)}
          {!activeRequests.some(item => ['pending', 'in_progress'].includes(item.status)) && <p className={styles.hint}>Chưa có yêu cầu đang mở.</p>}
          <button className={styles.subtle} onClick={() => { setTab('requests'); setDetails(false); }}>Xem tất cả yêu cầu<ChevronRight size={12} /></button>
        </div><p className={styles.detailsNote}><ShieldCheck size={14} />Nội dung trao đổi chỉ hiển thị với hai thành viên trong hội thoại này.</p>
      </aside>}
    </div> : <section role="tabpanel" id="requests-panel" aria-labelledby="requests-tab" className={styles.requestsPanel}>
      <div className={styles.requestFilters}><label className={styles.search}><Search size={15} /><input aria-label="Tìm yêu cầu" placeholder="Tìm mã, nội dung hoặc người gửi..." value={requestSearch} onChange={event => setRequestSearch(event.target.value)} /></label>
        <select aria-label="Hướng yêu cầu" value={requestDirection} onChange={event => setRequestDirection(event.target.value)}><option value="all">Tất cả yêu cầu</option><option value="received">Gửi đến tôi</option><option value="sent">Tôi đã gửi</option></select>
        <select aria-label="Trạng thái yêu cầu" value={requestStatus} onChange={event => setRequestStatus(event.target.value)}><option value="all">Mọi trạng thái</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="overdue">Quá hạn xử lý</option></select>
      </div>
      {loading && !data ? <div className={styles.empty}><Loader2 className={styles.spinning} size={24} /><p>Đang tải yêu cầu...</p></div> : filteredRequests.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Yêu cầu công việc</th><th>Người trao đổi</th><th>Ưu tiên</th><th>Trạng thái</th><th>Hạn xử lý</th></tr></thead><tbody>{filteredRequests.map(request => <tr key={request.id}><td><button onClick={() => setSelectedRequest(request)}>{request.title}</button><small>{requestCode(request)} · {request.sender_id === user.id ? 'Bạn đã gửi' : 'Gửi đến bạn'}</small></td><td>{request.sender_id === user.id ? request.recipient_name : request.sender_name}<small>{formatDate(request.created_at)}</small></td><td><Priority value={request.priority} /></td><td><Status value={request.status} /></td><td><span className={isOverdue(request) ? styles.overdue : ''}>{formatDate(request.due_at)}{isOverdue(request) && <small>Quá hạn xử lý</small>}</span></td></tr>)}</tbody></table></div> : <div className={styles.empty}><span className={styles.emptyIcon}><ClipboardList size={29} /></span><strong>{data?.requests.length ? 'Không tìm thấy yêu cầu phù hợp' : 'Mọi yêu cầu, một nơi theo dõi'}</strong><p>{data?.requests.length ? 'Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm.' : 'Gửi yêu cầu để phân công, tiếp nhận và theo dõi tiến độ công việc.'}</p><button className={styles.secondary} onClick={beginRequest} disabled={!data}><FilePlus2 size={15} />Tạo yêu cầu đầu tiên</button></div>}
      {summary && summary.requests_total > 200 && <p className={styles.hint}>Hiển thị 200 yêu cầu gần nhất trong tổng số {summary.requests_total} yêu cầu.</p>}
    </section>}
    {newConversation && data && <NewConversation contacts={data.contacts} onChoose={chooseContact} onClose={() => setNewConversation(false)} />}
    {newRequest && active && contact && <RequestForm contact={contact} conversationId={active.id} onClose={() => setNewRequest(false)} onSent={() => { setNewRequest(false); setTick(value => value + 1); stickToBottom.current = true; setNotice('Đã gửi yêu cầu. Bạn có thể theo dõi trạng thái trong hội thoại và tab Yêu cầu.'); notifyMessagingUpdated(); }} />}
    {currentRequest && <RequestDetail key={currentRequest.id} request={currentRequest} userId={user.id} onClose={() => setSelectedRequest(null)} onUpdated={updated => {
      setSelectedRequest(updated); setData(previous => previous ? { ...previous, requests: previous.requests.map(item => item.id === updated.id ? updated : item) } : previous);
      setTick(value => value + 1); notifyMessagingUpdated();
    }} onOpenConversation={() => { chooseConversation(currentRequest.conversation_id); setSelectedRequest(null); }} />}
  </div>;
}

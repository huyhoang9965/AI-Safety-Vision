import { authenticatedFetch } from './auth';

const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '') + '/api/messaging';
export const MESSAGING_UPDATED = 'safety-messaging-updated';

export type Contact = {
  id: string; full_name: string; avatar_url: string | null; department: string | null;
  job_title: string | null; role_code: string; role_name: string;
};
export type Conversation = {
  id: string; organization_id: string; partner_id: string; updated_at: string;
  last_message: string | null; last_kind: 'text' | 'request' | 'activity' | null;
  last_message_at: string | null; unread_count: number;
};
export type RequestStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';
export type TeamRequest = {
  id: string; request_no: number; conversation_id: string; sender_id: string; recipient_id: string;
  sender_name?: string; recipient_name?: string; title: string; description: string;
  category: 'support' | 'incident' | 'equipment' | 'shift' | 'other';
  priority: 'normal' | 'high' | 'urgent'; status: RequestStatus; due_at: string | null;
  resolution_note: string | null; created_at: string; updated_at: string;
};
export type Message = {
  id: number; conversation_id: string; sender_id: string; kind: 'text' | 'request' | 'activity';
  content: string; created_at: string; request: TeamRequest | null;
};
export type MessagePage = { items: Message[]; has_more: boolean; partner_read_id: number };
export type MessagingOverview = {
  contacts: Contact[]; conversations: Conversation[]; requests: TeamRequest[];
  summary: { unread: number; pending: number; in_progress: number; completed: number; overdue: number; requests_total: number };
};

export const statusLabels: Record<RequestStatus, string> = {
  pending: 'Chờ tiếp nhận', in_progress: 'Đang xử lý', completed: 'Hoàn thành', rejected: 'Đã từ chối', cancelled: 'Đã hủy',
};
export const priorityLabels = { normal: 'Bình thường', high: 'Ưu tiên cao', urgent: 'Khẩn cấp' };
export const categoryLabels = { support: 'Hỗ trợ vận hành', incident: 'Xử lý sự cố', equipment: 'Thiết bị & camera', shift: 'Ca trực', other: 'Yêu cầu khác' };

export async function messagingApi<T>(path: string, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await authenticatedFetch(base + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail : 'Không thể thực hiện thao tác. Vui lòng kiểm tra dữ liệu và thử lại.');
  return payload as T;
}

export function notifyMessagingUpdated() {
  window.dispatchEvent(new Event(MESSAGING_UPDATED));
}

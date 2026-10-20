import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { ApiUser } from '../lib/auth';
import type { Contact, Conversation, Message, TeamRequest } from '../lib/messaging';

const org = '10000000-0000-4000-8000-000000000001';
const adminId = '20000000-0000-4000-8000-000000000001';
const employeeId = '20000000-0000-4000-8000-000000000002';
const conversationId = '30000000-0000-4000-8000-000000000001';
const token = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature';
const now = new Date().toISOString();
const contacts: Contact[] = [
  { id: adminId, full_name: 'Nguyễn Minh Anh', avatar_url: null, department: 'Ban quản trị', job_title: 'Quản trị viên hệ thống', role_code: 'org_admin', role_name: 'Quản trị viên' },
  { id: employeeId, full_name: 'Trần Hoàng Nam', avatar_url: null, department: 'An toàn nhà máy', job_title: 'Nhân viên giám sát', role_code: 'camera_employee', role_name: 'Nhân viên camera' },
];

function makeState(empty = false) {
  const request: TeamRequest = {
    id: '40000000-0000-4000-8000-000000000001', request_no: 1, conversation_id: conversationId,
    sender_id: employeeId, recipient_id: adminId, sender_name: contacts[1].full_name, recipient_name: contacts[0].full_name,
    title: 'Kiểm tra kết nối camera kho nguyên liệu', description: 'Camera CAM-02 tại kho nguyên liệu mất tín hiệu từ đầu ca. Nhờ anh kiểm tra kết nối và hỗ trợ khôi phục để tiếp tục giám sát an toàn.',
    category: 'equipment', priority: 'high', status: 'pending', due_at: new Date(Date.now() + 86400000).toISOString(),
    resolution_note: null, created_at: now, updated_at: now,
  };
  return {
    conversations: empty ? [] : [{ id: conversationId, organization_id: org, partner_id: '', updated_at: now, last_message: '', last_kind: 'text', last_message_at: now, unread_count: 0 } as Conversation],
    messages: empty ? [] : [
      { id: 1, conversation_id: conversationId, sender_id: adminId, kind: 'text', content: 'Chào Nam, ca giám sát sáng nay có vấn đề gì cần hỗ trợ không?', created_at: now, request: null },
      { id: 2, conversation_id: conversationId, sender_id: employeeId, kind: 'text', content: 'Dạ, khu vực sản xuất vẫn ổn định. Riêng camera kho nguyên liệu đang mất kết nối, em gửi yêu cầu kiểm tra nhé.', created_at: now, request: null },
      { id: 3, conversation_id: conversationId, sender_id: employeeId, kind: 'request', content: request.title, created_at: now, request },
    ] as Message[],
    requests: empty ? [] : [request], read: { [adminId]: 0, [employeeId]: 0 } as Record<string, number>, sendFailure: false, overviewFailure: false,
    writes: [] as Record<string, unknown>[],
  };
}

async function install(context: BrowserContext, state: ReturnType<typeof makeState>, id = adminId, allowed = true) {
  const person = contacts.find(item => item.id === id)!;
  const user: ApiUser = { id, email: `${id}@example.test`, username: null, full_name: person.full_name, department: person.department,
    job_title: person.job_title, phone: null, avatar_url: null, status: 'active', email_verified: true,
    memberships: [{ organization_id: org, organization_code: 'FACTORY', organization_name: 'Nhà máy Bình Minh', role_code: person.role_code,
      role_name: person.role_name, is_default: true, permissions: [id === adminId ? 'dashboard.view' : 'camera.view', ...(allowed ? ['messaging.use'] : [])] }] };
  await context.addInitScript(({ user, token }) => {
    localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({ user, access_token: token, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer' }));
  }, { user, token });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const method = route.request().method();
    if (path === '/api/auth/me') return route.fulfill({ json: user });
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
    const unread = (conversation = conversationId) => state.messages.filter(item => item.conversation_id === conversation && item.sender_id !== id && item.id > state.read[id]).length;
    if (path === '/api/messaging/unread') return route.fulfill({ json: { unread: unread() } });
    if (path === '/api/messaging/overview') {
      if (state.overviewFailure) return route.fulfill({ status: 503, json: { detail: 'Dịch vụ tin nhắn tạm thời gián đoạn.' } });
      const conversations = state.conversations.map(item => {
        const last = state.messages.filter(message => message.conversation_id === item.id).at(-1);
        return { ...item, partner_id: id === adminId ? employeeId : adminId, last_message: last?.content || null,
          last_message_at: last?.created_at || null, last_kind: last?.kind || null, unread_count: unread(item.id) };
      });
      return route.fulfill({ json: { contacts: contacts.filter(item => item.id !== id), conversations, requests: state.requests,
        summary: { unread: unread(), pending: state.requests.filter(item => item.recipient_id === id && item.status === 'pending').length,
          in_progress: state.requests.filter(item => item.status === 'in_progress').length, completed: state.requests.filter(item => item.status === 'completed').length,
          overdue: 0, requests_total: state.requests.length } } });
    }
    if (path === '/api/messaging/conversations' && method === 'POST') {
      if (!state.conversations.length) state.conversations.push({ id: conversationId, organization_id: org, partner_id: '', updated_at: now, last_message: null, last_message_at: null, last_kind: null, unread_count: 0 });
      return route.fulfill({ status: 201, json: { id: conversationId } });
    }
    if (path.endsWith('/read')) {
      state.read[id] = Math.max(state.read[id], route.request().postDataJSON().through_id);
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith('/messages') && method === 'GET') {
      const before = Number(url.searchParams.get('before') || Infinity);
      const items = state.messages.filter(item => item.id < before).map(item => ({ ...item, request: item.request ? state.requests.find(request => request.id === item.request!.id) : null }));
      return route.fulfill({ json: { items: items.slice(-50), has_more: items.length > 50, partner_read_id: state.read[id === adminId ? employeeId : adminId] } });
    }
    if (path.endsWith('/messages') && method === 'POST') {
      const body = route.request().postDataJSON(); state.writes.push(body);
      if (state.sendFailure) return route.fulfill({ status: 503, json: { detail: 'Chưa gửi được tin nhắn. Vui lòng thử lại.' } });
      const message: Message = { id: (state.messages.at(-1)?.id || 0) + 1, conversation_id: conversationId, sender_id: id,
        kind: 'text', content: body.content, request: null, created_at: new Date().toISOString() };
      state.messages.push(message);
      return route.fulfill({ status: 201, json: { id: message.id } });
    }
    if (path.endsWith('/requests') && method === 'POST') {
      const body = route.request().postDataJSON(); state.writes.push(body);
      const recipient = id === adminId ? employeeId : adminId;
      const request: TeamRequest = { ...body, id: `40000000-0000-4000-8000-${String(state.requests.length + 1).padStart(12, '0')}`,
        request_no: state.requests.length + 1, conversation_id: conversationId, sender_id: id, recipient_id: recipient,
        sender_name: person.full_name, recipient_name: contacts.find(item => item.id === recipient)!.full_name, status: 'pending',
        resolution_note: null, created_at: now, updated_at: now };
      state.requests.unshift(request);
      const messageId = (state.messages.at(-1)?.id || 0) + 1;
      state.messages.push({ id: messageId, conversation_id: conversationId, sender_id: id, kind: 'request', content: request.title, created_at: now, request });
      return route.fulfill({ status: 201, json: { id: messageId, request_id: request.id } });
    }
    if (/\/requests\/[^/]+\/status$/.test(path)) {
      const request = state.requests.find(item => item.id === path.split('/').at(-2))!;
      const body = route.request().postDataJSON(); state.writes.push(body);
      request.status = body.status; request.resolution_note = body.note; request.updated_at = new Date().toISOString();
      state.messages.push({ id: (state.messages.at(-1)?.id || 0) + 1, conversation_id: conversationId, sender_id: id, kind: 'activity', content: `${person.full_name} đã cập nhật yêu cầu`, created_at: now, request });
      return route.fulfill({ json: request });
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected API: ${path}` } });
  });
}

async function ready(page: Page) {
  await page.goto('/dashboard/messages');
  await expect(page.getByRole('heading', { name: 'Tin nhắn & yêu cầu', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nội dung tin nhắn')).toBeVisible();
}

test('camera employee sees messaging from live monitoring without dashboard permission', async ({ context, page }, info) => {
  await install(context, makeState(), employeeId);
  await page.setViewportSize({ width: 1536, height: 1000 });
  await page.goto('/dashboard/live');
  const navigation = page.getByRole('navigation', { name: 'Điều hướng dashboard' });
  await expect(navigation.getByRole('link', { name: 'Giám sát trực tiếp', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: /Tin nhắn & yêu cầu/ })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Tổng quan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Tin nhắn(?: ·|$)/ })).toBeVisible();
  await navigation.getByRole('link', { name: /Tin nhắn & yêu cầu/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/messages$/);
  await expect(page.getByLabel('Nội dung tin nhắn')).toBeVisible();
  await page.screenshot({ path: info.outputPath('camera-employee-messaging.png'), fullPage: true });
});

test('both roles exchange messages, confirm read receipts and preserve sent content after reload', async ({ browser, context, page }, info) => {
  const state = makeState(); await install(context, state);
  await page.setViewportSize({ width: 1536, height: 1100 }); await ready(page);
  await page.getByLabel('Thông tin hội thoại', { exact: true }).click();
  await page.screenshot({ path: info.outputPath('messaging-desktop.png'), fullPage: true });
  await page.getByLabel('Nội dung tin nhắn').fill('Anh sẽ kiểm tra đường truyền camera kho A ngay.');
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(page.getByRole('log').getByText('Anh sẽ kiểm tra đường truyền camera kho A ngay.')).toBeVisible();
  const peer = await browser.newContext(); await install(peer, state, employeeId);
  const employeePage = await peer.newPage(); await ready(employeePage);
  await expect(employeePage.getByRole('log').getByText('Anh sẽ kiểm tra đường truyền camera kho A ngay.')).toBeVisible();
  await expect.poll(() => state.read[employeeId]).toBe(4);
  await page.getByRole('button', { name: 'Tải lại tin nhắn và yêu cầu' }).click();
  await expect(page.getByRole('log').getByText('Đã đọc').first()).toBeVisible();
  await employeePage.getByLabel('Nội dung tin nhắn').fill('Em đã nhận thông tin, cảm ơn anh.');
  await employeePage.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(employeePage.getByRole('log').getByText('Em đã nhận thông tin, cảm ơn anh.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('log').getByText('Em đã nhận thông tin, cảm ơn anh.')).toBeVisible();
  expect(state.writes.every(item => !('sender_id' in item))).toBe(true);
  await peer.close();
});

test('recipient accepts and completes a request and sender sees the result', async ({ browser, context, page }) => {
  const state = makeState(); await install(context, state); await ready(page);
  await page.getByRole('button', { name: 'Xem & tiếp nhận' }).click();
  await page.getByRole('button', { name: 'Tiếp nhận', exact: true }).click();
  await page.getByRole('button', { name: 'Tiếp nhận yêu cầu', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Đang xử lý', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Hoàn thành', exact: true }).click();
  await page.getByLabel('Ghi chú xử lý (không bắt buộc)').fill('Đã thay cáp mạng, camera hoạt động ổn định.');
  await page.getByRole('button', { name: 'Xác nhận hoàn thành', exact: true }).click();
  await expect(dialog.getByText('Hoàn thành', { exact: true })).toBeVisible();
  await page.getByLabel('Đóng hộp thoại').click();
  const peer = await browser.newContext(); await install(peer, state, employeeId);
  const peerPage = await peer.newPage(); await ready(peerPage);
  await peerPage.getByRole('tab', { name: /Yêu cầu/ }).click();
  await peerPage.getByLabel('Hướng yêu cầu').selectOption('sent');
  await peerPage.getByLabel('Trạng thái yêu cầu').selectOption('completed');
  await peerPage.getByRole('button', { name: 'Kiểm tra kết nối camera kho nguyên liệu', exact: true }).click();
  await expect(peerPage.getByRole('dialog').getByText('Đã thay cáp mạng, camera hoạt động ổn định.')).toBeVisible();
  await expect(peerPage.getByRole('dialog').getByRole('button', { name: 'Hoàn thành', exact: true })).toHaveCount(0);
  await peer.close();
});

test('new conversations and structured requests work from an empty inbox', async ({ context, page }) => {
  const state = makeState(true); await install(context, state, employeeId);
  await page.goto('/dashboard/messages');
  await page.getByRole('button', { name: 'Tạo yêu cầu', exact: true }).click();
  await page.getByLabel('Tìm người nhận').fill('Nguyễn');
  await page.getByRole('dialog').getByRole('button', { name: /Nguyễn Minh Anh/ }).click();
  await page.getByLabel('Tiêu đề yêu cầu').fill('Bổ sung nhân sự giám sát ca chiều');
  await page.getByLabel('Nội dung yêu cầu').fill('Khu vực kho B cần thêm một nhân sự hỗ trợ trong ca chiều.');
  await page.getByLabel('Mức ưu tiên').selectOption('urgent');
  await page.getByRole('button', { name: 'Gửi yêu cầu', exact: true }).click();
  await expect(page.getByRole('log').getByText('Bổ sung nhân sự giám sát ca chiều', { exact: true })).toBeVisible();
  await expect(page.getByRole('log').getByText('Khẩn cấp', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Xem chi tiết', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hủy yêu cầu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tiếp nhận', exact: true })).toHaveCount(0);
});

test('failed sends retain drafts and reuse the same idempotency key on retry', async ({ context, page }) => {
  const state = makeState(); await install(context, state); await ready(page);
  state.sendFailure = true;
  await page.getByLabel('Nội dung tin nhắn').fill('Tin nhắn đang chờ gửi');
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(page.getByText('Chưa gửi được tin nhắn. Vui lòng thử lại.')).toBeVisible();
  await expect(page.getByLabel('Nội dung tin nhắn')).toHaveValue('Tin nhắn đang chờ gửi');
  state.sendFailure = false;
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(page.getByRole('log').getByText('Tin nhắn đang chờ gửi')).toBeVisible();
  expect(state.writes[0].client_id).toBe(state.writes[1].client_id);
  await expect(page.getByLabel('Nội dung tin nhắn')).toHaveValue('');
});

test('mobile navigation, request filters, and dialogs fit the viewport', async ({ context, page }, info) => {
  const state = makeState(); await install(context, state, employeeId);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/dashboard/messages');
  await page.getByRole('button', { name: /Nguyễn Minh Anh.*Quản trị viên/ }).click();
  await expect(page.getByLabel('Nội dung tin nhắn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('messaging-mobile.png'), fullPage: true });
  await page.getByLabel('Quay lại danh sách hội thoại').click();
  await expect(page.getByLabel('Tìm hội thoại')).toBeVisible();
  await page.getByRole('tab', { name: /Yêu cầu/ }).click();
  await page.getByLabel('Trạng thái yêu cầu').selectOption('completed');
  await expect(page.getByText('Không tìm thấy yêu cầu phù hợp')).toBeVisible();
  await page.getByLabel('Trạng thái yêu cầu').selectOption('all');
  await page.getByRole('button', { name: 'Kiểm tra kết nối camera kho nguyên liệu', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('connection failures have a recoverable empty state and users without permission cannot open messaging', async ({ context, page, browser }) => {
  const state = makeState(); state.overviewFailure = true;
  await install(context, state); await page.goto('/dashboard/messages');
  await expect(page.getByText('Dịch vụ tin nhắn tạm thời gián đoạn.')).toBeVisible();
  state.overviewFailure = false;
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByLabel('Nội dung tin nhắn')).toBeVisible();
  const denied = await browser.newContext(); await install(denied, makeState(), employeeId, false);
  const deniedPage = await denied.newPage(); await deniedPage.goto('/dashboard/messages');
  await expect(deniedPage).toHaveURL(/\/dashboard\/live$/);
  await expect(deniedPage.getByRole('link', { name: 'Tin nhắn & yêu cầu', exact: true })).toHaveCount(0);
  await denied.close();
});

import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const key = 'ai-safety-auth-session-v1';
const user = { id: 'session-test-user', email: 'session@example.test', full_name: 'Kiểm Tra Phiên', status: 'active',
  memberships: [{ organization_id: 'test-org', is_default: true, role_name: 'Quản trị viên',
    permissions: ['dashboard.view', 'event.view', 'event.acknowledge', 'chat.use'] }] };
const jwt = (expires: number, name: string) => 'test.' + Buffer.from(JSON.stringify({ exp: expires })).toString('base64url') + '.' + name;

async function setup(context: BrowserContext, options: { expired?: boolean; remember?: boolean; refreshFailure?: number; offlineMe?: boolean; refreshDelay?: number } = {}) {
  const oldToken = jwt(Math.floor(Date.now() / 1000) + (options.expired ? -1 : 900), 'old');
  const state = { oldToken, token: oldToken, refreshToken: 'test-refresh-original', refreshes: 0,
    rejectOld: false, messages: [] as unknown[], successfulMessages: 0, offlineMe: !!options.offlineMe,
    refreshFailure: options.refreshFailure ?? 0, refreshDelay: options.refreshDelay ?? 0 };
  await context.addInitScript(({ key, user, oldToken, remember }) => {
    if (sessionStorage.getItem('session-test-seeded') || localStorage.getItem(key) || sessionStorage.getItem(key)) return;
    sessionStorage.setItem('session-test-seeded', '1');
    (remember ? localStorage : sessionStorage).setItem(key, JSON.stringify({ access_token: oldToken,
      refresh_token: 'test-refresh-original', token_type: 'bearer', expires_in: 900, user }));
  }, { key, user, oldToken, remember: options.remember !== false });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/refresh') {
      state.refreshes++;
      if (state.refreshDelay) await new Promise(resolve => setTimeout(resolve, state.refreshDelay));
      if (state.refreshFailure || request.postDataJSON().refresh_token !== state.refreshToken) {
        await route.fulfill({ status: state.refreshFailure || 401, json: { detail: 'Refresh unavailable' } });
        return;
      }
      state.token = jwt(Math.floor(Date.now() / 1000) + 3600, 'new-' + state.refreshes);
      state.refreshToken = 'test-refresh-rotated-' + state.refreshes;
      await route.fulfill({ json: { access_token: state.token, refresh_token: state.refreshToken,
        token_type: 'bearer', expires_in: 3600, user } });
      return;
    }
    if (path === '/api/health') { await route.fulfill({ json: { status: 'ok' } }); return; }
    if (path === '/api/auth/logout') { await route.fulfill({ status: 204 }); return; }
    if (path === '/api/auth/me' && state.offlineMe) { await route.abort('failed'); return; }
    const authorization = request.headers().authorization;
    if (path === '/api/chat/messages') state.messages.push(request.postDataJSON());
    if (authorization !== 'Bearer ' + state.token || (state.rejectOld && authorization === 'Bearer ' + oldToken)) {
      await route.fulfill({ status: 401, json: { detail: 'Access token đã hết hạn' } }); return;
    }
    let payload: unknown;
    if (path === '/api/auth/me') payload = user;
    else if (path === '/api/alerts') payload = { items: [], total: 0, limit: 50, offset: 0,
      summary: { total: 0, new: 0, acknowledged: 0, resolved: 0, dismissed: 0, overdue: 0,
        acknowledgeable_new: 0, critical_new: 0, high_new: 0, today: 0, average_acknowledge_seconds: null },
      filters: { event_types: [], sites: [], cameras: [] } };
    else if (path === '/api/chat/status') payload = { available: true, provider: 'OpenRouter', mode: 'openrouter',
      llm_configured: true, speech_available: false, suggested_prompts: [] };
    else if (path === '/api/chat/conversations') payload = [];
    else if (path === '/api/chat/messages') {
      state.successfulMessages++;
      const message = { model_name: null, latency_ms: 20, metadata: {}, created_at: new Date().toISOString(), feedback: null };
      payload = { conversation_id: 'test-conversation', mode: 'openrouter', tool_calls: [],
        user_message: { ...message, id: 'test-question', role: 'user', content: request.postDataJSON().message },
        assistant_message: { ...message, id: 'test-reply', role: 'assistant', content: 'Phiên vẫn hoạt động.' } };
    } else throw new Error('Unexpected API path: ' + path);
    await route.fulfill({ json: payload });
  });
  return state;
}

async function ready(page: Page) {
  await page.goto('/dashboard/alerts');
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
}

test('renews before 15 minutes without leaving the dashboard', async ({ context, page }) => {
  await page.clock.install();
  const state = await setup(context);
  await ready(page);
  await page.clock.fastForward(14 * 60000 + 15000);
  await expect.poll(() => state.refreshes).toBe(1);
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).access_token, key)).toBe(state.token);
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/dashboard\/alerts/);
});

for (const remember of [true, false]) test(`restores expired access token and preserves ${remember ? 'remembered' : 'tab'} session`, async ({ context, page }) => {
  const state = await setup(context, { expired: true, remember });
  await ready(page);
  expect(state.refreshes).toBe(1);
  const saved = await page.evaluate(({ key, remember }) => ({
    session: JSON.parse((remember ? localStorage : sessionStorage).getItem(key)!),
    other: (remember ? sessionStorage : localStorage).getItem(key),
  }), { key, remember });
  expect(saved.session.refresh_token).toBe(state.refreshToken);
  expect(saved.other).toBeNull();
});

test('chat retries an expired token once and preserves the message body', async ({ context, page }) => {
  const state = await setup(context);
  await ready(page);
  await page.getByRole('button', { name: 'Mở trợ lý AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trợ lý AI Safety' });
  await expect(dialog.getByRole('heading', { name: /Xin chào/ })).toBeVisible();
  state.rejectOld = true;
  await dialog.getByRole('textbox', { name: 'Tin nhắn cho trợ lý AI' }).fill('Chào bạn');
  await dialog.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await expect(dialog.getByText('Phiên vẫn hoạt động.', { exact: true })).toBeVisible();
  expect(state.refreshes).toBe(1);
  expect(state.successfulMessages).toBe(1);
  expect(state.messages).toEqual([{ message: 'Chào bạn', conversation_id: null }, { message: 'Chào bạn', conversation_id: null }]);
  await expect(dialog.getByText(/token.*hết hạn/)).toHaveCount(0);
});

test('two tabs share a single token rotation', async ({ context, page }) => {
  const state = await setup(context, { expired: true, refreshDelay: 250 });
  const second = await context.newPage();
  await Promise.all([ready(page), ready(second)]);
  expect(state.refreshes).toBe(1);
  await expect(page).toHaveURL(/dashboard\/alerts/);
  await expect(second).toHaveURL(/dashboard\/alerts/);
});

test('temporary connection loss retains the session on navigation and reload', async ({ context, page }) => {
  const state = await setup(context, { offlineMe: true });
  await ready(page);
  await page.reload();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  expect(await page.evaluate(key => !!localStorage.getItem(key), key)).toBe(true);
  state.offlineMe = false;
  await page.reload();
  await expect(page).toHaveURL(/dashboard\/alerts/);
  expect(state.refreshes).toBe(0);
});

test('temporary refresh outage retains expired credentials and recovers online', async ({ context, page }) => {
  const state = await setup(context, { expired: true, refreshFailure: 503 });
  await page.goto('/dashboard/alerts');
  await expect(page.getByRole('button', { name: 'Mở trợ lý AI', exact: true })).toBeVisible();
  expect(await page.evaluate(key => !!localStorage.getItem(key), key)).toBe(true);
  state.refreshFailure = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.token).not.toBe(state.oldToken);
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
});

test('pending refresh cannot restore an explicitly logged-out session', async ({ context, page }) => {
  const state = await setup(context);
  await ready(page);
  state.rejectOld = true;
  state.refreshDelay = 600;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect.poll(() => state.refreshes).toBe(1);
  await page.getByRole('button', { name: /Kiểm Tra Phiên/ }).click();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => state.token).not.toBe(state.oldToken);
  expect(await page.evaluate(key => localStorage.getItem(key) || sessionStorage.getItem(key), key)).toBeNull();
});

test('revoked refresh token still requires login and stops refreshing', async ({ context, page }) => {
  const state = await setup(context, { expired: true, refreshFailure: 401 });
  await page.goto('/dashboard/alerts');
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(key => localStorage.getItem(key) || sessionStorage.getItem(key), key)).toBeNull();
  expect(state.refreshes).toBe(1);
});

import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, path = '/dashboard/alerts', options: { extraNew?: number; canAcknowledge?: boolean; failBulkOnce?: boolean; bulkDelay?: number } = {}) {
  const user = { id: 'test-user', full_name: 'Nguyễn Văn Kiểm Tra', email: 'test@example.test',
    memberships: [{ organization_id: 'test-org', is_default: true, role_name: 'Quản trị viên',
      permissions: ['dashboard.view', 'event.view', 'event.acknowledge', 'event.resolve'] }] };
  if (options.canAcknowledge === false) user.memberships[0].permissions = ['dashboard.view', 'event.view'];
  await page.addInitScript(user => {
    localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
      access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
    }));
  }, user);
  const now = Date.now();
  const alerts = [
    { id: 'old-new', title: 'Thiếu mũ quá 1 ngày', status: 'new', overdue: true, age: 90000 },
    { id: 'old-ack', title: 'Đã xác nhận nhưng chưa xử lý', status: 'acknowledged', overdue: false, age: 172800 },
    { id: 'recent', title: 'Phát hiện mới trong ngày', status: 'new', overdue: false, age: 3600 },
    { id: 'done', title: 'Cảnh báo cũ đã hoàn tất', status: 'resolved', overdue: false, age: 259200 },
  ].map(item => ({ ...item, event_code: 'NO_HELMET', event_name: 'Thiếu mũ bảo hộ', description: null,
    severity: item.status === 'acknowledged' ? 'critical' : 'high', confidence: .9, object_count: 1, detected_at: new Date(now - item.age * 1000).toISOString(),
    acknowledged_at: item.status === 'new' ? null : new Date(now).toISOString(), resolved_at: item.status === 'resolved' ? new Date(now).toISOString() : null,
    resolution_note: null, site_code: 'SITE', site_name: 'Nhà máy', zone_code: null, zone_name: null,
    camera_code: 'CAM-01', camera_name: 'Camera kiểm tra', snapshot_url: null, thumbnail_url: null, video_url: null,
    acknowledged_by: null, resolved_by: null, incident_id: null }));
  for (let i = 0; i < (options.extraNew || 0); i++) {
    alerts.push({ ...alerts[2], id: 'extra-' + i, title: 'Vi phạm bổ sung ' + i });
  }
  const requests: URL[] = [];
  const bulkRequests: unknown[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname !== '/api/health') expect(request.headers().authorization, url.pathname).toBe('Bearer test-only');
    let payload: unknown;
    if (url.pathname === '/api/auth/me') payload = user;
    else if (url.pathname === '/api/health') payload = { status: 'ok' };
    else if (url.pathname === '/api/alerts') {
      requests.push(url);
      let items = alerts.filter(item => url.searchParams.get('overdue') !== 'true' || item.overdue);
      const status = url.searchParams.get('status');
      if (status) items = items.filter(item => item.status === status);
      if (['today', '24h'].includes(url.searchParams.get('period') || '')) items = items.filter(item => item.age < 86400);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      payload = { items: items.slice(offset, offset + limit), total: items.length, limit, offset,
        summary: { total: alerts.length, overdue: alerts.filter(item => item.overdue).length,
          new: alerts.filter(item => item.status === 'new').length,
          acknowledgeable_new: options.canAcknowledge === false ? 0 : alerts.filter(item => item.status === 'new').length,
          acknowledged: alerts.filter(item => item.status === 'acknowledged').length,
          resolved: alerts.filter(item => item.status === 'resolved').length,
          dismissed: alerts.filter(item => item.status === 'dismissed').length,
          high_open: 2, critical_open: alerts.filter(item => item.severity === 'critical' && ['new', 'acknowledged'].includes(item.status)).length,
          critical_new: alerts.filter(item => item.status === 'new' && item.severity === 'critical').length,
          high_new: alerts.filter(item => item.status === 'new').length, today: 1, average_acknowledge_seconds: 900 },
        filters: { event_types: [], sites: [], cameras: [] } };
    } else if (request.method() === 'POST' && url.pathname === '/api/alerts/acknowledge-all') {
      bulkRequests.push(request.postDataJSON());
      if (options.bulkDelay) await new Promise(resolve => setTimeout(resolve, options.bulkDelay));
      if (options.failBulkOnce && bulkRequests.length === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Không thể cập nhật cảnh báo' }) });
        return;
      }
      const pending = alerts.filter(item => item.status === 'new');
      pending.forEach(item => { item.status = 'acknowledged'; item.overdue = false; item.acknowledged_at = new Date().toISOString(); });
      payload = { success: true, acknowledged_count: pending.length, message: `Đã xác nhận ${pending.length} cảnh báo` };
    } else if (request.method() === 'POST' && url.pathname.startsWith('/api/alerts/')) {
      const [, , , id, action] = url.pathname.split('/');
      const item = alerts.find(item => item.id === id)!;
      item.status = action === 'acknowledge' ? 'acknowledged' : action === 'dismiss' ? 'dismissed' : 'resolved';
      item.overdue = false;
      if (item.status === 'acknowledged') item.acknowledged_at = new Date().toISOString();
      else item.resolved_at = new Date().toISOString();
      payload = { success: true, message: 'Đã cập nhật cảnh báo', alert: item };
    } else throw new Error('Unexpected request ' + url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto(path);
  await expect(page.getByText('1 cảnh báo quá hạn xử lý', { exact: true })).toBeVisible();
  return { requests, errors, bulkRequests, alerts };
}

test('overdue labels and bell notifications include old pending alerts only', async ({ page }) => {
  const { errors } = await setup(page);
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).getByText('Quá hạn', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Đã xác nhận nhưng chưa xử lý/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Cảnh báo cũ đã hoàn tất/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Thông báo', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Có 1 cảnh báo chưa xác nhận sau 24 giờ.');
  await expect(page.getByRole('link', { name: /Phát hiện mới trong ngày/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Xem tất cả cảnh báo quá hạn' }).click();
  await expect(page).toHaveURL(/overdue=true/);
  await expect(page.getByRole('button', { name: /Phát hiện mới trong ngày/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Đã xác nhận 1$/ }).click();
  await expect(page.getByRole('button', { name: /Đã xác nhận nhưng chưa xử lý/ }).getByText('Quá hạn', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('overdue tab switches away from today to show older pending alerts', async ({ page }) => {
  const { requests } = await setup(page);
  const period = page.locator('select').filter({ has: page.locator('option[value="today"]') });
  await period.selectOption('today');
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Quá hạn 1$/ }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toBeVisible();
  await expect(period).toHaveValue('all');
  expect(requests.some(url => url.searchParams.get('overdue') === 'true' && url.searchParams.get('limit') === '50' && url.searchParams.get('period') === 'all')).toBe(true);
});

test('single acknowledgement ends overdue and moves to history; resolution and dismissal remain available', async ({ page }) => {
  await setup(page, '/dashboard/alerts?overdue=true');
  await page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).click();
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByText(/cảnh báo quá hạn xử lý/)).toHaveCount(0);
  await expect(page.getByLabel('1 cảnh báo quá hạn', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Đã xác nhận 2$/ }).click();
  await page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).getByText('Quá hạn', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Đã xử lý', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Xác nhận thao tác' }) });
  await form.locator('textarea').fill('Đã hoàn tất xử lý.');
  await form.getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Đã xác nhận nhưng chưa xử lý/ })).toBeVisible();
  await page.getByRole('button', { name: 'Báo sai', exact: true }).click();
  await form.locator('textarea').fill('Xác minh là cảnh báo sai.');
  await form.getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByText(/cảnh báo quá hạn xử lý/, { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('1 cảnh báo quá hạn', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Thông báo', exact: true }).click();
  await expect(page.getByText('Không có cảnh báo quá hạn', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Thông báo', exact: true }).click();
  await page.getByRole('button', { name: /^Đã xử lý 2$/ }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toBeVisible();
});

test('overdue warning and labels stay visible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).getByText('Quá hạn', { exact: true })).toBeVisible();
  const notice = page.getByRole('alert').filter({ hasText: '1 cảnh báo quá hạn xử lý' });
  const layout = await notice.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth }; });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
});

test('bulk empties all queue pages, removes overdue and keeps records only in acknowledged history after reload', async ({ page }) => {
  const { bulkRequests, alerts, errors } = await setup(page, '/dashboard/alerts', { extraNew: 53 });
  await page.getByRole('button', { name: 'Trang sau', exact: true }).click();
  await expect(page.getByText('Trang 2/2 · 55 cảnh báo')).toBeVisible();
  const button = page.getByRole('button', { name: 'Xác nhận tất cả (55)', exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Xác nhận tất cả vi phạm' });
  await expect(dialog).toContainText('bao gồm mọi trang');
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
  expect(bulkRequests).toHaveLength(0);
  const period = page.locator('select').filter({ has: page.locator('option[value="today"]') });
  await period.selectOption('today');
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toHaveCount(0);
  await button.click();
  await dialog.getByRole('textbox').fill('Đã tiếp nhận tất cả vi phạm');
  await dialog.getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByRole('button', { name: 'Xác nhận tất cả (0)', exact: true })).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Đã xác nhận 55 cảnh báo', { exact: true })).toBeVisible();
  expect(bulkRequests).toEqual([{ note: 'Đã tiếp nhận tất cả vi phạm' }]);
  expect(alerts.filter(item => item.status === 'acknowledged')).toHaveLength(56);
  expect(alerts.find(item => item.id === 'done')?.status).toBe('resolved');
  await expect(page.getByText(/cảnh báo quá hạn xử lý/)).toHaveCount(0);
  await expect(page.getByLabel('1 cảnh báo quá hạn', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tất cả 0$/ })).toBeVisible();
  await expect(page.getByText('Trang 1/1 · 0 cảnh báo')).toBeVisible();
  await expect(page.getByText('0 nghiêm trọng', { exact: true })).toBeVisible();
  await expect(page.getByText('0 mức cao chưa xác nhận', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  await expect(page.getByText(/cảnh báo quá hạn xử lý/)).toHaveCount(0);
  await page.getByRole('button', { name: /^Đã xác nhận 56$/ }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ }).getByText('Quá hạn', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Tất cả 0$/ }).click();
  await expect(page.getByRole('button', { name: /Thiếu mũ quá 1 ngày/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('bulk failure preserves violations and allows retry; blocks duplicate submissions', async ({ page }) => {
  const { bulkRequests, alerts } = await setup(page, '/dashboard/alerts', { failBulkOnce: true, bulkDelay: 300 });
  await page.getByRole('button', { name: 'Xác nhận tất cả (2)', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const submit = dialog.getByRole('button', { name: 'Xác nhận thao tác' });
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Hủy', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Không thể cập nhật cảnh báo', { exact: true })).toBeVisible();
  expect(alerts.filter(item => item.status === 'new')).toHaveLength(2);
  expect(bulkRequests).toHaveLength(1);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('button', { name: 'Xác nhận tất cả (0)', exact: true })).toBeDisabled();
  expect(bulkRequests).toHaveLength(2);
});

test('bulk action is hidden without acknowledge permission', async ({ page }) => {
  await setup(page, '/dashboard/alerts', { canAcknowledge: false });
  await expect(page.getByRole('button', { name: /^Xác nhận tất cả/ })).toHaveCount(0);
});

test('bulk action and confirmation fit mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const button = page.getByRole('button', { name: 'Xác nhận tất cả (2)', exact: true });
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (const element of [button, dialog]) {
    const layout = await element.evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth }; });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.width);
  }
  await dialog.getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  await expect(page.getByText(/cảnh báo quá hạn xử lý/)).toHaveCount(0);
});

test('bulk completion refreshes the bell even when an older notification request is still pending', async ({ page }) => {
  const { alerts } = await setup(page);
  await expect(page.getByLabel('1 cảnh báo quá hạn', { exact: true })).toBeVisible();
  let releaseOld!: () => void;
  let oldRequestStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  const started = new Promise<void>(resolve => { oldRequestStarted = resolve; });
  let holdNext = true;
  const oldSnapshot = { items: [{ ...alerts[0] }], summary: { overdue: 1 } };
  await page.route('**/api/alerts?*', async route => {
    const url = new URL(route.request().url());
    if (holdNext && url.searchParams.get('limit') === '5' && url.searchParams.get('overdue') === 'true') {
      holdNext = false;
      oldRequestStarted();
      await gate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(oldSnapshot) });
    } else await route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('safety-alerts-updated')));
  await started;
  await page.getByRole('button', { name: 'Xác nhận tất cả (2)', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận thao tác' }).click();
  await expect(page.getByText('Không còn cảnh báo chờ xác nhận', { exact: true })).toBeVisible();
  releaseOld();
  await expect(page.getByLabel('1 cảnh báo quá hạn', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/cảnh báo quá hạn xử lý/)).toHaveCount(0);
});

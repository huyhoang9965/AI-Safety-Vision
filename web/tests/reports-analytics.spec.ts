import { test, expect, type Page } from '@playwright/test';

const user = { id: 'reports-test', full_name: 'Kiểm Tra Báo Cáo', email: 'reports@example.test',
  memberships: [{ organization_id: 'test-org', role_name: 'Quản trị viên', permissions: ['dashboard.view', 'report.view'] }] };
const rows = [
  { day: '2026-10-02', total: 10, critical: 2, resolved: 4, incidents: 1 },
  { day: '2026-10-03', total: 25, critical: 8, resolved: 10, incidents: 3 },
  { day: '2026-10-04', total: 0, critical: 0, resolved: 0, incidents: 0 },
  { day: '2026-10-05', total: 15, critical: 3, resolved: 5, incidents: 2 },
  { day: '2026-10-06', total: 5, critical: 1, resolved: 2, incidents: 0 },
  { day: '2026-10-07', total: 0, critical: 0, resolved: 0, incidents: 0 },
  { day: '2026-10-08', total: 8, critical: 1, resolved: 3, incidents: 1 },
];
function payload(empty = false, days = 7) {
  return { period: { days, start_at: '2026-10-02T00:00:00Z', end_at: '2026-10-08T12:00:00Z', previous_start_at: '2026-09-25T00:00:00Z' },
    summary: { total_events: empty ? 0 : 63, previous_events: 70, event_change_percent: -10, critical_events: 15, critical_change_percent: 0,
      open_events: 30, resolved_events: 24, resolution_rate: 38.1, average_acknowledge_seconds: 120, average_resolution_seconds: 900,
      average_confidence: .87, incidents: 7, overdue_incidents: 0, reporting_cameras: 4 },
    response_metrics: { pending_events: 0, acknowledged_events: 30, overdue_events: 0, acknowledge_samples: empty ? 0 : 5,
      resolution_samples: empty ? 0 : 2, acknowledged_within_24h: empty ? 0 : 4, acknowledge_p50_seconds: empty ? null : 120,
      acknowledge_p95_seconds: empty ? null : 600, acknowledge_p99_seconds: empty ? null : 900,
      resolution_p50_seconds: empty ? null : 1800, resolution_p95_seconds: empty ? null : 3600, resolution_p99_seconds: empty ? null : 7200 },
    trend: empty ? rows.map(row => ({ ...row, total: 0, critical: 0, resolved: 0, incidents: 0 })) : rows,
    event_types: [], severities: [], statuses: [], sites: [], cameras: [], heatmap: [], recent_events: [], filters: { sites: [{ code: 'MAIN', name: 'Nhà máy chính' }] },
    generated_at: '2026-10-08T12:00:00Z' };
}
async function setup(page: Page, empty = false) {
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/auth/me') body = user;
    else if (url.pathname === '/api/health') body = { status: 'ok' };
    else if (url.pathname === '/api/reports/overview') {
      expect(route.request().headers().authorization).toBe('Bearer test-only');
      body = payload(empty, Number(url.searchParams.get('period')?.slice(0, -1)));
    } else throw new Error('Unexpected API path ' + url.pathname);
    await route.fulfill({ json: body });
  });
  await page.goto('/dashboard/reports');
  const section = page.getByRole('region', { name: 'Xu hướng cảnh báo', exact: true });
  await expect(section.getByRole('slider')).toBeVisible();
  return { section, chart: section.getByRole('slider') };
}

test('hover reveals exact values for all four series and click keeps the selected day', async ({ page }) => {
  const { section, chart } = await setup(page);
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width / 6, box.y + 100);
  const tooltip = section.getByRole('status');
  await expect(tooltip).toContainText('03/10/2026');
  for (const [label, value] of [['Tổng cảnh báo', '25'], ['Nghiêm trọng', '8'], ['Đã xử lý', '10'], ['Sự cố', '3']]) {
    await expect(tooltip.locator('div').filter({ hasText: label })).toContainText(value);
  }
  await page.mouse.click(box.x + box.width / 6, box.y + 100);
  await page.mouse.move(box.x - 10, box.y - 10);
  await expect(tooltip).toContainText('03/10/2026');
  await expect(section.getByText('Đang giữ ngày 03/10/2026')).toBeVisible();
  await section.getByRole('button', { name: 'Bỏ chọn', exact: true }).click();
  await expect(tooltip).toHaveCount(0);
  await expect(section.locator('path[data-series]')).toHaveCount(4);
  await section.screenshot({ path: '../storage/outputs/reports-trend-desktop.png' });
});

test('keyboard selects endpoints, zero-count days and toggles individual lines', async ({ page }) => {
  const { section, chart } = await setup(page);
  await chart.focus(); await chart.press('Home');
  await expect(chart).toHaveAttribute('aria-valuetext', /02\/10\/2026: Tổng cảnh báo 10/);
  await chart.press('ArrowRight'); await chart.press('ArrowRight');
  await expect(section.getByRole('status')).toContainText('04/10/2026');
  await expect(section.getByRole('status').locator('div b')).toHaveText(['0', '0', '0', '0']);
  await chart.press('End'); await expect(section.getByRole('status')).toContainText('08/10/2026');
  await chart.press('Escape'); await expect(section.getByRole('status')).toHaveCount(0);
  const toggle = section.getByRole('button', { name: 'Nghiêm trọng 15', exact: true });
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(section.locator('path[data-series="critical"]')).toHaveCount(0);
  await toggle.click(); await expect(section.locator('path[data-series="critical"]')).toHaveCount(1);
});

test('adds accurate daily statistics and a table without counting acknowledged alerts as overdue', async ({ page }) => {
  const { section } = await setup(page);
  await expect(section.locator('article').filter({ hasText: 'Cảnh báo trung bình/ngày' }).locator('strong')).toHaveText('9');
  await expect(section.locator('article').filter({ hasText: 'Ngày nhiều cảnh báo nhất' })).toContainText('03/10/2026');
  await expect(section.locator('article').filter({ has: page.getByText('Ngày không có cảnh báo', { exact: true }) }).locator('strong')).toHaveText('2 / 7');
  await expect(section.locator('article').filter({ hasText: 'Tỷ trọng nghiêm trọng' }).locator('strong')).toHaveText('23,8%');
  await section.getByRole('button', { name: 'Chi tiết theo ngày' }).click();
  const table = section.getByRole('table');
  await expect(table.getByRole('row').filter({ hasText: '03/10/2026' }).getByRole('cell')).toHaveText(['25', '8', '10', '3']);
  const response = page.getByRole('region', { name: 'Hiệu quả tiếp nhận cảnh báo' });
  await expect(response.locator('article').filter({ hasText: 'Quá hạn xác nhận' }).locator('strong')).toHaveText('0');
  await expect(response.locator('article').filter({ hasText: 'Xác nhận trong 24 giờ' }).locator('strong')).toHaveText('80%');
  await expect(response.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Xác nhận', exact: true }) }).getByRole('cell')).toHaveText(['5', '2 phút', '10 phút', '15 phút']);
});

test('empty data has no invented timings or unsafe zero-warning claim', async ({ page }) => {
  const { section, chart } = await setup(page, true);
  await expect(section.locator('article').filter({ hasText: 'Ngày nhiều cảnh báo nhất' }).locator('strong')).toHaveText('—');
  await expect(section.getByText('Không khẳng định camera đã hoạt động')).toBeVisible();
  await chart.focus(); await chart.press('End');
  await expect(section.getByRole('status').locator('div b')).toHaveText(['0', '0', '0', '0']);
  await expect(page.getByRole('region', { name: 'Hiệu quả tiếp nhận cảnh báo' }).getByRole('rowheader', { name: 'Xác nhận', exact: true }).locator('..').getByRole('cell')).toHaveText(['0', '—', '—', '—']);
  await expect(section).not.toContainText('NaN');
});

test('changing filters discards an older slow response and resets the selected date', async ({ page }) => {
  const { section, chart } = await setup(page);
  await chart.focus(); await chart.press('End');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/reports/overview?**', async route => {
    const period = new URL(route.request().url()).searchParams.get('period');
    if (period === '7d') await pending;
    const body = payload(false, period === '7d' ? 7 : 90);
    body.trend = [{ day: '2026-10-08', total: period === '7d' ? 999 : 90, critical: 0, resolved: 0, incidents: 0 }];
    body.generated_at = period === '7d' ? '2026-10-08T13:00:00Z' : '2026-10-08T14:00:00Z';
    await route.fulfill({ json: body }).catch(() => {});
  });
  await page.getByRole('button', { name: '7 ngày', exact: true }).click();
  await page.getByRole('button', { name: '90 ngày', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Tổng cảnh báo 90', exact: true })).toBeVisible();
  await expect(section.getByRole('status')).toHaveCount(0);
  release();
  await expect(section.getByRole('button', { name: 'Tổng cảnh báo 999', exact: true })).toHaveCount(0);
});

test('mobile tap pins a day and both ends of the plot remain readable', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const { section, chart } = await setup(page);
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  await page.touchscreen.tap(box.x + 2, box.y + 90);
  await expect(section.getByRole('status')).toContainText('02/10/2026');
  await page.touchscreen.tap(box.x + box.width - 2, box.y + 90);
  await expect(section.getByRole('status')).toContainText('08/10/2026');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await section.screenshot({ path: '../storage/outputs/reports-trend-mobile.png' });
  await context.close();
});

test('the 12-month chart selects every daily sample instead of only displayed axis labels', async ({ page }) => {
  const { section, chart } = await setup(page);
  const body = payload(false, 365);
  body.trend = Array.from({ length: 365 }, (_, index) => ({
    day: new Date(Date.UTC(2025, 9, 9 + index)).toISOString().slice(0, 10), total: index, critical: index % 10, resolved: index % 7, incidents: index % 3,
  }));
  body.generated_at = '2026-10-08T15:00:00Z';
  await page.route('**/api/reports/overview?**', route => route.fulfill({ json: body }));
  await page.getByRole('button', { name: '12 tháng', exact: true }).click();
  await expect(section.getByText('365 NGÀY', { exact: true })).toBeVisible();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 182 / 364, box.y + 100);
  await expect(section.getByRole('status').locator('div b')).toHaveText(['182', '2', '0', '2']);
  await chart.focus(); await chart.press('End');
  await expect(section.getByRole('status')).toContainText('08/10/2026');
  await expect(section.getByRole('status').locator('div b')).toHaveText(['364', '4', '0', '1']);
  await section.getByRole('button', { name: 'Chi tiết theo ngày' }).click();
  await expect(section.getByRole('table').locator('tbody tr')).toHaveCount(365);
});

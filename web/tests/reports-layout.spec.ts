import { test, expect, type Page } from '@playwright/test';

const user = { id: 'report-layout-test', full_name: 'Kiểm tra thống kê', email: 'reports@example.test', memberships: [{ organization_id: 'org-1', role_name: 'Quản trị viên', permissions: ['dashboard.view', 'report.view'] }] };
function reportData() {
  return {
    period: { days: 30, start_at: '2026-09-14T00:00:00Z', end_at: '2026-10-14T12:00:00Z', previous_start_at: '2026-08-14T00:00:00Z' },
    summary: { total_events: 1234765, previous_events: 1000000, event_change_percent: 23.5, critical_events: 222372, critical_change_percent: 0, open_events: 111275, resolved_events: 1000000, resolution_rate: 81, average_acknowledge_seconds: 120, average_resolution_seconds: 900, average_confidence: .87, incidents: 7, overdue_incidents: 0, reporting_cameras: 5005 },
    trend: [{ day: '2026-10-13', total: 198, critical: 150, resolved: 0, incidents: 2 }, { day: '2026-10-14', total: 1234567, critical: 222222, resolved: 1000000, incidents: 5 }],
    response_metrics: { pending_events: 164, acknowledged_events: 30, overdue_events: 0, acknowledge_samples: 5, resolution_samples: 2, acknowledged_within_24h: 4, acknowledge_p50_seconds: 120, acknowledge_p95_seconds: 600, acknowledge_p99_seconds: 900, resolution_p50_seconds: 1800, resolution_p95_seconds: 3600, resolution_p99_seconds: 7200 },
    event_types: [{ code: 'PPE_MISSING_HELMET_WITH_LONG_CODE', name: 'Không đội mũ bảo hộ trong khu vực sản xuất cần kiểm soát an toàn', color: '#537eea', total: 1234567, previous_total: 1000000, change_percent: 23.5, average_confidence: .93 }],
    severities: [{ key: 'critical', label: 'Nghiêm trọng', total: 222372, percentage: 18 }, { key: 'high', label: 'Cao', total: 1012393, percentage: 82 }],
    statuses: [{ key: 'new', label: 'Mới', total: 164, percentage: 1 }, { key: 'acknowledged', label: 'Đã xác nhận', total: 111111, percentage: 9 }, { key: 'resolved', label: 'Đã xử lý', total: 1123490, percentage: 90 }, { key: 'dismissed', label: 'Bỏ qua', total: 0, percentage: 0 }],
    sites: [{ code: 'MAIN_FACTORY', name: 'Nhà máy chính', total: 198, critical: 150, open_events: 164, resolved: 0, resolution_rate: 0, cameras: 5 }, { code: 'VERY_LONG_FACTORY_CODE_FOR_SAFETY_MONITORING_02', name: 'Nhà máy sản xuất và trung chuyển với tên cơ sở rất dài để kiểm tra bố cục', total: 1234567, critical: 222222, open_events: 111111, resolved: 1234567, resolution_rate: 100, cameras: 5000 }, { code: 'EMPTY', name: 'Cơ sở chưa có cảnh báo', total: 0, critical: 0, open_events: 0, resolved: 0, resolution_rate: 0, cameras: 0 }],
    cameras: [{ code: 'CAM-01', name: 'Camera quan sát khu vực sản xuất với tên rất dài', site_name: 'Nhà máy chính', zone_name: 'Khu vực sản xuất', status: 'maintenance', total: 1234567, critical: 222222, average_confidence: .93 }],
    heatmap: [{ weekday: 1, hour: 6, total: 198 }, { weekday: 3, hour: 14, total: 1234567 }],
    recent_events: [{ id: 'event-1', title: 'Nghi ngờ không đội mũ bảo hộ trong khu vực sản xuất cần kiểm tra', event_code: 'PPE', event_name: 'Thiếu mũ', severity: 'critical', status: 'acknowledged', confidence: .93, detected_at: '2026-10-14T03:00:00Z', site_name: 'Nhà máy chính', zone_name: 'Sản xuất', camera_code: 'CAM-01', camera_name: 'Toàn cảnh', snapshot_url: null }],
    filters: { sites: [{ code: 'MAIN_FACTORY', name: 'Nhà máy chính' }] }, generated_at: '2026-10-14T12:00:00Z',
  };
}
async function setup(page: Page) {
  const state = { requests: [] as string[] };
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({ access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user })), user);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/auth/me') body = user;
    else if (url.pathname === '/api/health') body = { status: 'ok', database: 'connected' };
    else if (url.pathname === '/api/reports/overview') {
      expect(route.request().headers().authorization).toBe('Bearer test-only'); state.requests.push(url.search); body = reportData();
    } else if (url.pathname === '/api/reports/export') {
      state.requests.push(url.search);
      await route.fulfill({ contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename=report.csv' }, body: 'co_so,tong_canh_bao\nMAIN_FACTORY,198\n' }); return;
    } else throw new Error('Unexpected API path ' + url.pathname);
    await route.fulfill({ json: body });
  });
  await page.goto('/dashboard/reports');
  await expect(page.getByRole('region', { name: 'Hiệu suất an toàn theo cơ sở', exact: true }).getByRole('table')).toBeVisible();
  return state;
}

for (const width of [1920, 1280, 1100, 390]) {
  test(`site metrics occupy separate cells and keep alignment at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await setup(page);
    const section = page.getByRole('region', { name: 'Hiệu suất an toàn theo cơ sở', exact: true });
    const table = section.getByRole('table');
    const first = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /Nhà máy chính/ }) });
    await expect(first.getByRole('cell')).toHaveText(['198', '150', '164', '0,0%', '5']);
    const second = table.getByRole('row').filter({ hasText: 'VERY_LONG_FACTORY_CODE' });
    await expect(second.getByRole('cell')).toHaveText(['1.234.567', '222.222', '111.111', '100,0%', '5.000']);
    const checks = await table.evaluate(element => {
      const headers = Array.from(element.querySelectorAll('thead th')).map(cell => cell.getBoundingClientRect());
      return Array.from(element.querySelectorAll('tbody tr')).flatMap(row => Array.from(row.children).map((cell, index) => {
        const rect = cell.getBoundingClientRect();
        const valuesInside = Array.from(cell.querySelectorAll('strong')).every(metric => {
          const box = metric.getBoundingClientRect(); return box.left >= rect.left - .5 && box.right <= rect.right + .5;
        });
        return { aligned: Math.abs(rect.left - headers[index].left) < 1 && Math.abs(rect.width - headers[index].width) < 1, valuesInside };
      }));
    });
    expect(checks.every(check => check.aligned && check.valuesInside)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 390) {
      const viewport = page.getByRole('region', { name: 'Bảng hiệu suất cơ sở', exact: true });
      expect(await viewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await viewport.focus(); await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await expect(first.getByRole('cell').last()).toBeInViewport();
    }
    await section.screenshot({ path: `../storage/outputs/reports-sites-${width}.png`, style: 'header[class*="topbar"] { visibility: hidden; }' });
  });
}

test('long names and large counts in violation, risk and event panels stay inside each panel', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1000 }); await setup(page);
  for (const name of ['Loại vi phạm phổ biến', 'Cơ cấu rủi ro', 'Camera rủi ro cao', 'Cảnh báo gần đây']) {
    const panel = page.getByRole('region', { name, exact: true });
    const fits = await panel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('strong, b, em, small')).every(node => {
        const box = node.getBoundingClientRect(); return box.width === 0 || (box.left >= rect.left - 1 && box.right <= rect.right + 1);
      });
    }); expect(fits, name).toBe(true);
  }
  await expect(page.getByRole('region', { name: 'Camera rủi ro cao', exact: true })).toContainText('Bảo trì');
});

test('mobile keeps severity and processing status visible with long event descriptions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  const events = page.getByRole('region', { name: 'Cảnh báo gần đây', exact: true }); await events.scrollIntoViewIfNeeded();
  await expect(events.getByText('Nghiêm trọng', { exact: true })).toBeVisible();
  await expect(events.getByText('Đã xác nhận', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('period and facility filters still drive report requests and CSV export', async ({ page }) => {
  const state = await setup(page); await page.getByRole('combobox').selectOption('MAIN_FACTORY');
  await page.getByRole('button', { name: '7 ngày', exact: true }).click();
  await expect.poll(() => state.requests.some(query => query.includes('period=7d') && query.includes('site=MAIN_FACTORY'))).toBe(true);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('bao-cao-an-toan-7d.csv');
  expect(state.requests.at(-1)).toContain('site=MAIN_FACTORY');
});
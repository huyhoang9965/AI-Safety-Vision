import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import presets from '../lib/demo-camera-presets.json';
import { cameraDemoVideo } from '../lib/demo-cameras';
import { fulfillCameraVideo } from './camera-media-fixture';

const fixtureVideos = presets.flatMap((preset, index) => preset.filenames.map((filename, clip) => ({ id: 1000 + index * 10 + clip, filename })));

const allPermissions = ['dashboard.view', 'camera.view', 'camera.manage', 'event.view', 'incident.view', 'report.view'];
const camera = (index: number) => ({ id: 'camera-' + index, code: 'CAM-' + String(index).padStart(2, '0'),
  name: index === 2 ? 'Kho nguyên liệu' : 'Camera nhà máy ' + index, site_code: index === 2 ? 'WAREHOUSE' : 'MAIN',
  site_name: index === 2 ? 'Kho hàng' : 'Nhà máy chính', zone_name: 'Khu sản xuất', snapshot_url: null,
  status: index === 2 ? 'offline' : 'online', health_status: null, is_active: true,
  stream_configured: index !== 2, last_seen_at: '2026-10-14T03:00:00Z' });

async function setup(page: Page, options: { empty?: boolean; permissions?: string[]; fail?: string[]; cameraCount?: number; snapshot?: string; realVideos?: { id: number; filename: string }[] } = {}) {
  const user = { id: 'overview-test', full_name: 'Kiểm tra tổng quan', email: 'overview@example.test',
    memberships: [{ organization_id: 'test-org', role_name: 'Quản trị viên', is_default: true, permissions: options.permissions || allPermissions }] };
  const state = { today: options.empty ? 0 : 23, failed: new Set(options.fail || []), requests: [] as string[] };
  const videos = options.realVideos || fixtureVideos;
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    state.requests.push(url.pathname + url.search);
    if (state.failed.has(url.pathname)) { await route.fulfill({ status: 503, json: { detail: 'Unavailable' } }); return; }
    if (/\/api\/videos\/\d+\/stream/.test(url.pathname)) {
      if (options.realVideos) await route.continue();
      else await fulfillCameraVideo(route);
      return;
    }
    let body;
    if (url.pathname === '/api/auth/me') body = user;
    else if (url.pathname === '/api/health') body = { status: 'ok', database: 'connected', test_videos: 14, loaded_models: [] };
    else {
      expect(route.request().headers().authorization).toBe('Bearer test-only');
      if (url.pathname === '/api/infrastructure') body = { cameras: options.empty ? [] : Array.from({ length: options.cameraCount || 7 }, (_, i) => ({ ...camera(i + 1), snapshot_url: i === 0 ? options.snapshot || null : null })),
        sites: [{ code: 'MAIN', name: 'Nhà máy chính' }, { code: 'WAREHOUSE', name: 'Kho hàng' }],
        summary: { cameras: options.empty ? 0 : 7, online: options.empty ? 0 : 6, offline: options.empty ? 0 : 1, warning: 0, maintenance: 0, disabled: 0 } };
      else if (url.pathname === '/api/videos/test') body = [...videos].reverse();
      else if (url.pathname === '/api/models') body = options.empty ? [] : [
        { name: 'RF-DETR', type: 'detection', version: '1.0', connected: true, loaded: true, status: 'ready' },
        { name: 'VideoMAE', type: 'classification', version: '2.0', connected: false, loaded: false, status: 'offline' },
      ];
      else if (url.pathname === '/api/alerts') body = { items: options.empty || url.searchParams.has('overdue') ? [] : [
        { id: 'alert-1', title: 'Không đội mũ bảo hộ', camera_code: 'CAM-01', camera_name: 'Camera nhà máy 1',
          severity: 'critical', status: 'new', detected_at: '2026-10-14T03:00:00Z', overdue: true },
      ], summary: { today: state.today, total: options.empty ? 0 : 50, new: options.empty ? 0 : 8, acknowledged: 2,
        resolved: 40, dismissed: 0, overdue: options.empty ? 0 : 3, critical_open: 2, high_open: 1 } };
      else if (url.pathname === '/api/incidents') {
        expect(url.searchParams.get('period')).toBe('all');
        body = { items: options.empty ? [] : [{ id: 'incident-1', incident_no: 42, title: 'Điều tra sự cố xe nâng',
          status: 'investigating', severity: 'high', assigned_to: { full_name: 'Nguyễn An' }, overdue: true }],
          summary: { open: options.empty ? 0 : 4, investigating: options.empty ? 0 : 2, overdue: options.empty ? 0 : 1, unassigned: 2 } };
      } else if (url.pathname === '/api/reports/overview') body = { trend: [{ day: '2026-10-14', total: 23, critical: 2, resolved: 8, incidents: 1 }], generated_at: '2026-10-14T03:00:00Z' };
      else throw new Error('Unexpected API path ' + url.pathname);
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Tổng quan hệ thống' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Làm mới', exact: true })).toBeEnabled();
  return state;
}

const kpi = (page: Page, name: string) => page.getByRole('region', { name: 'Chỉ số tổng quan' }).getByRole('link', { name, exact: true });

test('shows API totals, unresolved incidents and report trends without recent alerts', async ({ page }) => {
  await setup(page);
  await expect(kpi(page, 'Camera giám sát').locator('strong')).toHaveText('7');
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('23');
  await expect(kpi(page, 'Sự cố đang mở').locator('strong')).toHaveText('6');
  await expect(kpi(page, 'Mô hình AI kết nối').locator('strong')).toHaveText('1/2');
  await expect(page.getByRole('region', { name: 'Cảnh báo gần đây' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sự cố cần xử lý' })).toContainText('Nguyễn An');
  await expect(page.getByRole('region', { name: 'Xu hướng cảnh báo', exact: true }).getByRole('slider')).toBeVisible();
  await expect(page.getByText('Chờ API sự kiện')).toHaveCount(0);
});

test('camera filters, pagination and keyboard-accessible details use real devices', async ({ page }) => {
  await setup(page);
  const panel = page.getByRole('region', { name: 'Hệ thống camera', exact: true });
  await expect(panel.getByRole('button', { name: /^Xem camera / })).toHaveCount(6);
  await panel.getByRole('button', { name: 'Xem thêm camera' }).click();
  await expect(panel.getByRole('button', { name: /^Xem camera / })).toHaveCount(7);
  await panel.getByLabel('Trạng thái camera').selectOption('offline');
  await expect(panel.getByRole('button', { name: /^Xem camera / })).toHaveCount(1);
  await panel.getByRole('button', { name: /Xem camera CAM-02/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Kho nguyên liệu');
  await expect(page.getByRole('dialog')).toContainText('Chưa cấu hình');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await panel.getByLabel('Nhà máy camera').selectOption('MAIN');
  await expect(panel).toContainText('Không tìm thấy camera phù hợp');
  await panel.getByRole('button', { name: 'Xóa bộ lọc' }).click();
  await panel.getByRole('textbox', { name: 'Tìm camera' }).fill('không tồn tại');
  await expect(panel).toContainText('Không tìm thấy camera phù hợp');
});

test('partial failure keeps other panels and marks retained data until recovery', async ({ page }) => {
  const state = await setup(page);
  state.failed.add('/api/alerts');
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Cảnh báo');
  await expect(page.getByRole('main')).toContainText('Dữ liệu lúc');
  await expect(kpi(page, 'Camera giám sát').locator('strong')).toHaveText('7');
  await expect(kpi(page, 'Vi phạm hôm nay')).toContainText('Đồng bộ thất bại');
  state.failed.clear(); state.today = 31;
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('31');
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('Dữ liệu lúc');
});

test('initial API failures do not pretend there are no alerts or configured cameras', async ({ page }) => {
  await setup(page, { fail: ['/api/infrastructure', '/api/alerts', '/api/incidents', '/api/models', '/api/reports/overview'] });
  for (const name of ['Camera giám sát', 'Vi phạm hôm nay', 'Sự cố đang mở', 'Mô hình AI kết nối']) {
    await expect(kpi(page, name).locator('strong')).toHaveText('—');
  }
  await expect(page.getByRole('region', { name: 'Hệ thống camera', exact: true })).toContainText('Chưa tải được dữ liệu');
  await expect(page.getByText('Chưa có cảnh báo được ghi nhận')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Xem camera / })).toHaveCount(0);
});

test('successful empty datasets show zero and accurate empty states', async ({ page }) => {
  await setup(page, { empty: true });
  await expect(kpi(page, 'Camera giám sát').locator('strong')).toHaveText('0');
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('0');
  await expect(kpi(page, 'Sự cố đang mở').locator('strong')).toHaveText('0');
  await expect(kpi(page, 'Mô hình AI kết nối').locator('strong')).toHaveText('0/0');
  await expect(page.getByText('Chưa có camera trong tổ chức')).toBeVisible();
  await expect(page.getByText('Cảnh báo gần đây', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('restricted accounts do not fetch protected datasets or show inaccessible actions', async ({ page }) => {
  const state = await setup(page, { permissions: ['dashboard.view'] });
  expect(state.requests.every(path => ['/api/health', '/api/auth/me'].includes(path))).toBe(true);
  await expect(page.getByText('Chưa có quyền xem dữ liệu này')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Mở giám sát trực tiếp' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Chỉ số tổng quan' }).getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Thao tác nhanh' }).getByRole('link')).toHaveCount(0);
});

test('automatically refreshes every 30 seconds and pause still permits manual refresh', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  state.today = 35;
  await page.clock.runFor(30050);
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('35');
  await page.getByRole('checkbox', { name: 'Tự cập nhật 30 giây' }).uncheck();
  const count = state.requests.filter(path => path.startsWith('/api/infrastructure')).length;
  state.today = 36;
  await page.clock.runFor(60050);
  expect(state.requests.filter(path => path.startsWith('/api/infrastructure')).length).toBe(count);
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('35');
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(kpi(page, 'Vi phạm hôm nay').locator('strong')).toHaveText('36');
});

test('fits a narrow screen and camera details remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Xem camera CAM-01/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const box = (await page.getByRole('dialog').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Đóng chi tiết camera' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: '../storage/outputs/overview-mobile.png', fullPage: true });
});

test('renders controlled videos for all nine mapped cameras and plays visible streams', async ({ page }) => {
  const state = await setup(page, { cameraCount: 9 });
  const panel = page.getByRole('region', { name: 'Hệ thống camera', exact: true });
  await panel.getByRole('button', { name: 'Xem thêm camera' }).click();
  await expect(panel.locator('video')).toHaveCount(9);
  await expect(panel.getByRole('img')).toHaveCount(0);
  const video = panel.locator('video').first();
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
  for (let index = 1; index <= 9; index++) {
    const clip = cameraDemoVideo(fixtureVideos, camera(index).code)!;
    await expect(panel.locator('video').nth(index - 1)).toHaveAttribute('src', new RegExp(`/api/videos/${clip.id}/stream`));
  }
  expect(await video.evaluate(element => ({ controls: (element as HTMLVideoElement).controls, muted: (element as HTMLVideoElement).muted, loop: (element as HTMLVideoElement).loop, nested: Boolean(element.closest('button')) }))).toEqual({ controls: true, muted: true, loop: true, nested: false });
  expect(state.requests.some(url => url.includes('/thumbnail'))).toBe(false);
  await panel.getByRole('button', { name: /Xem camera CAM-02/ }).click();
  await expect(page.getByRole('dialog').locator('video')).toHaveCount(1);
  await expect.poll(() => page.getByRole('dialog').locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
});

test('snapshot settings do not turn the video preview into a still image', async ({ page }) => {
  const state = await setup(page, { snapshot: '/api/snapshots/camera-1' });
  const video = page.locator('video[aria-label^="Video camera CAM-01"]');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('src', /\/api\/videos\/1000\/stream/);
  expect(state.requests).not.toContain('/api/snapshots/camera-1');
});

test('native pause, seek and resume work and refresh preserves playback position', async ({ page }) => {
  await setup(page);
  const video = page.locator('video[aria-label^="Video camera CAM-01"]');
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
  await video.evaluate(element => new Promise<void>(resolve => {
    const media = element as HTMLVideoElement; media.pause();
    media.addEventListener('seeked', () => resolve(), { once: true }); media.currentTime = 1.5;
  }));
  expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Làm mới', exact: true })).toBeEnabled();
  expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1);
  expect(await video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await video.scrollIntoViewIfNeeded();
  await video.evaluate(element => (element as HTMLVideoElement).play());
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1.6);
});

test('failed videos recover from the player retry without requesting thumbnails', async ({ page }) => {
  const state = await setup(page, { fail: ['/api/videos/1000/stream'] });
  const video = page.locator('video[aria-label^="Video camera CAM-01"]');
  await video.scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Thử lại video CAM-01', exact: true })).toBeVisible({ timeout: 15000 });
  state.failed.clear();
  await page.getByRole('button', { name: 'Thử lại video CAM-01', exact: true }).click();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
  expect(state.requests.some(url => url.includes('/thumbnail'))).toBe(false);
});

test('all nine overview cameras decode and advance actual backend video streams', async ({ page, request }) => {
  test.setTimeout(60000);
  const auditFile = path.resolve('..', 'storage', 'outputs', 'playback-audit.json');
  test.skip(!fs.existsSync(auditFile), 'Local media catalog is required for actual video verification.');
  const health = await request.get('http://localhost:8000/api/health').catch(() => null);
  test.skip(!health?.ok(), 'The local backend is required for actual video verification.');
  const videos = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  await page.setViewportSize({ width: 1600, height: 1600 });
  await setup(page, { cameraCount: 9, realVideos: videos });
  const panel = page.getByRole('region', { name: 'Hệ thống camera', exact: true });
  await panel.getByRole('button', { name: 'Xem thêm camera' }).click();
  await expect(panel.locator('video')).toHaveCount(9);
  await panel.scrollIntoViewIfNeeded();
  await expect.poll(() => panel.locator('video').evaluateAll(elements => elements.every(element => {
    const video = element as HTMLVideoElement;
    return video.videoWidth > 100 && video.currentTime > .1 && !video.paused && !video.error;
  })), { timeout: 20000 }).toBe(true);
  await panel.screenshot({ path: '../storage/outputs/overview-camera-videos-real.png', style: 'header[class*="topbar"] { visibility: hidden; }' });
});
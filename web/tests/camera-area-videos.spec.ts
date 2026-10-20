import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import presets from '../lib/demo-camera-presets.json';
import { cameraDemoVideo } from '../lib/demo-cameras';
import { fulfillCameraVideo } from './camera-media-fixture';

const fixtures = presets.flatMap((preset, index) => preset.filenames.map((filename, clip) => ({ id: 1000 + index * 10 + clip, filename, stream_url: `/api/videos/${1000 + index * 10 + clip}/stream` })));
function camera(index: number) {
  return { id: 'camera-' + index, code: 'CAM-' + String(index).padStart(2, '0'), name: 'Camera ' + index,
    site_id: 'site-1', site_code: 'MAIN', site_name: 'Nhà máy chính', zone_id: 'zone-1', zone_code: 'PRODUCTION', zone_name: 'Sản xuất',
    snapshot_url: 'http://localhost:8000/obsolete-snapshot.jpg', status: 'online', is_active: true,
    stream_configured: true, manufacturer: null, model: null, ip_address: null, latitude: null, longitude: null,
    fps: 20, resolution_width: 320, resolution_height: 180, installed_at: null, last_seen_at: null,
    deployment_count: 0, health_status: 'online', latest_latency_ms: 10, latest_packet_loss_pct: 0, updated_at: '2026-10-14T03:00:00Z' };
}
async function setup(page: Page, options: { actual?: boolean; failCatalog?: boolean; unknown?: boolean; failStream?: boolean } = {}) {
  const user = { id: 'camera-video-test', full_name: 'Kiểm tra video camera', email: 'camera@example.test',
    memberships: [{ organization_id: 'org-1', role_name: 'Quản trị viên', permissions: ['dashboard.view', 'camera.view', 'camera.manage'] }] };
  const videos: { id: number; filename: string; stream_url: string }[] = options.actual ? JSON.parse(fs.readFileSync(path.resolve('..', 'storage', 'outputs', 'playback-audit.json'), 'utf8')) : fixtures;
  const devices = Array.from({ length: 9 }, (_, index) => camera(index + 1));
  if (options.unknown) devices[0].code = 'CUSTOM-01';
  const state = { failStream: Boolean(options.failStream), failCatalog: Boolean(options.failCatalog), requests: [] as string[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({ access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user })), user);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); state.requests.push(url.pathname);
    if (/\/api\/videos\/\d+\/stream/.test(url.pathname)) {
      if (state.failStream && url.pathname === '/api/videos/1000/stream') await route.abort('failed');
      else if (options.actual) await route.continue();
      else await fulfillCameraVideo(route);
      return;
    }
    if (url.pathname !== '/api/health') expect(route.request().headers().authorization).toBe('Bearer test-only');
    let body;
    if (url.pathname === '/api/auth/me') body = user;
    else if (url.pathname === '/api/health') body = { status: 'ok', database: 'connected' };
    else if (url.pathname === '/api/videos/test') {
      if (state.failCatalog) { await route.fulfill({ status: 503, json: { detail: 'Offline' } }); return; }
      body = [...videos].reverse();
    } else if (url.pathname === '/api/infrastructure') body = { cameras: devices,
      sites: [{ id: 'site-1', code: 'MAIN', name: 'Nhà máy chính', zone_count: 1, camera_count: 9, is_active: true }],
      zones: [{ id: 'zone-1', site_id: 'site-1', site_code: 'MAIN', code: 'PRODUCTION', name: 'Sản xuất', camera_count: 9, is_active: true, is_restricted: false }],
      summary: { sites: 1, zones: 1, cameras: 9, online: 9, offline: 0, warning: 0, maintenance: 0, disabled: 0, restricted_zones: 0 } };
    else if (url.pathname.startsWith('/api/infrastructure/cameras/')) {
      const device = devices.find(item => item.id === url.pathname.split('/').at(-1))!;
      body = { ...device, health_samples: [], deployments: [], events_24h: 0, events_7d: 0 };
    } else throw new Error('Unexpected path ' + url.pathname);
    await route.fulfill({ json: body });
  });
  await page.goto('/dashboard/cameras');
  await expect(page.getByRole('heading', { name: 'Camera & khu vực', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Xem camera / })).toHaveCount(9);
  return { state, videos, devices };
}
const grid = (page: Page) => page.locator('div[class*="cameraGrid"]');
const detail = (page: Page) => page.getByRole('region', { name: 'Video camera đã chọn', exact: true });

async function plays(video: ReturnType<Page['locator']>) {
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate(element => {
    const media = element as HTMLVideoElement;
    return media.videoWidth > 0 && media.currentTime > .1 && !media.paused && !media.error;
  }), { timeout: 15000 }).toBe(true);
}

test('camera area grid and selected details use controlled videos mapped by filename', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const { state, videos } = await setup(page);
  await expect(grid(page).locator('video')).toHaveCount(9);
  await expect(grid(page).getByRole('img')).toHaveCount(0);
  for (let index = 1; index <= 9; index++) {
    const clip = cameraDemoVideo(videos, camera(index).code)!;
    await expect(grid(page).locator('video').nth(index - 1)).toHaveAttribute('src', new RegExp(`/api/videos/${clip.id}/stream`));
  }
  const video = grid(page).locator('video').first();
  await plays(video);
  expect(await video.evaluate(element => Boolean(element.closest('button')))).toBe(false);
  await video.evaluate(element => (element as HTMLVideoElement).pause());
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await video.evaluate(element => (element as HTMLVideoElement).play());
  await plays(video);
  await page.getByRole('button', { name: 'Xem camera CAM-02 Camera 2', exact: true }).click();
  await expect(detail(page).locator('video')).toHaveAttribute('src', /\/api\/videos\/1010\/stream/);
  await plays(detail(page).locator('video'));
  expect(state.requests.some(url => url.includes('/thumbnail'))).toBe(false);
  expect(state.errors).toEqual([]);
});

test('camera-area table keeps video playback in the selected details', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await setup(page);
  await page.getByTitle('Dạng bảng', { exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'CAM-03' }).click();
  await expect(detail(page).locator('video')).toHaveAttribute('src', /\/api\/videos\/1020\/stream/);
  await plays(detail(page).locator('video'));
});

test('catalog failures preserve camera data and recover after synchronizing', async ({ page }) => {
  const { state } = await setup(page, { failCatalog: true });
  await expect(page.getByText('Không thể tải nguồn video camera. Bấm Đồng bộ để thử lại.')).toBeVisible();
  await expect(grid(page).locator('video')).toHaveCount(0);
  state.failCatalog = false;
  await page.getByRole('button', { name: 'Đồng bộ', exact: true }).click();
  await expect(grid(page).locator('video')).toHaveCount(9);
  await plays(grid(page).locator('video').first());
  expect(state.errors).toEqual([]);
});

test('unknown cameras do not play a clip belonging to a different device', async ({ page }) => {
  await setup(page, { unknown: true });
  const card = page.getByRole('button', { name: 'Xem camera CUSTOM-01 Camera 1', exact: true }).locator('..');
  await expect(card).toContainText('Chưa có nguồn video cho camera này');
  await expect(card.locator('video')).toHaveCount(0);
});

test('camera-area video recovers from failed media requests using retry', async ({ page }) => {
  const { state } = await setup(page, { failStream: true });
  const player = grid(page).locator('article').first();
  await player.scrollIntoViewIfNeeded();
  await expect(player.getByRole('button', { name: 'Thử lại video CAM-01', exact: true })).toBeVisible({ timeout: 15000 });
  state.failStream = false;
  await player.getByRole('button', { name: 'Thử lại video CAM-01', exact: true }).click();
  await plays(player.locator('video'));
});

test('scrolling pauses offscreen previews and preserves a user pause on return', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await setup(page);
  const first = grid(page).locator('video').first();
  await plays(first);
  await grid(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => first.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await grid(page).evaluate(element => { element.scrollTop = 0; });
  await plays(first);
  await first.evaluate(element => (element as HTMLVideoElement).pause());
  await grid(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await grid(page).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => first.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
});

test('mobile camera area fits the screen and its detail video plays', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Xem camera CAM-02 Camera 2', exact: true }).click();
  await plays(detail(page).locator('video'));
});

test('all nine camera-area previews play real backend streams when brought into view', async ({ page, request }) => {
  test.setTimeout(90000);
  test.skip(!fs.existsSync(path.resolve('..', 'storage', 'outputs', 'playback-audit.json')), 'Local playback catalog is required.');
  const health = await request.get('http://localhost:8000/api/health').catch(() => null);
  test.skip(!health?.ok(), 'Local backend is required for actual media verification.');
  await page.setViewportSize({ width: 1800, height: 1100 });
  const { state } = await setup(page, { actual: true });
  for (let index = 0; index < 9; index++) await plays(grid(page).locator('video').nth(index));
  await page.getByRole('button', { name: 'Xem camera CAM-09 Camera 9', exact: true }).click();
  await plays(detail(page).locator('video'));
  expect(state.errors).toEqual([]);
  await page.screenshot({ path: '../storage/outputs/camera-area-videos-real.png', fullPage: true });
});
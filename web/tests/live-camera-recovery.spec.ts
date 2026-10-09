import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const auditFile = path.resolve('..', 'storage', 'outputs', 'playback-audit.json');
const user = { id: 'live-recovery-test', full_name: 'Kiểm Tra Camera', email: 'camera@example.test',
  memberships: [{ organization_id: 'test-org', role_name: 'Quản trị viên',
    permissions: ['dashboard.view', 'camera.view', 'event.view'] }] };

async function setup(page: Page, fail: (id: number, count: number) => boolean) {
  test.skip(!fs.existsSync(auditFile), 'Prepare demo playback copies first.');
  const videos = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  const counts = new Map<number, number>();
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), match = url.pathname.match(/\/api\/videos\/(\d+)\/stream/);
    if (match) {
      const id = Number(match[1]), count = (counts.get(id) || 0) + 1;
      counts.set(id, count);
      if (fail(id, count)) await route.abort('failed');
      else await route.continue();
      return;
    }
    const payload = url.pathname === '/api/auth/me' ? user : url.pathname === '/api/videos/test' ? videos
      : url.pathname === '/api/models' ? [] : url.pathname === '/api/health' ? { status: 'ok' }
      : url.pathname === '/api/alerts' ? { items: [], total: 0, summary: { overdue: 0 } } : null;
    if (!payload) throw new Error('Unexpected API path ' + url.pathname);
    await route.fulfill({ json: payload });
  });
  await page.goto('/dashboard/live');
  await expect(page.locator('video')).toHaveCount(4);
  return { counts, videos };
}

async function playing(page: Page, count: number) {
  await expect(page.locator('video')).toHaveCount(count);
  await expect.poll(() => page.locator('video').evaluateAll(elements => elements.every(element => {
    const video = element as HTMLVideoElement;
    return video.videoWidth > 0 && video.currentTime > .1 && !video.paused && !video.error;
  })), { timeout: 15000 }).toBe(true);
}

test('four camera streams automatically recover from their first network failure', async ({ page }) => {
  const { counts } = await setup(page, (_id, count) => count === 1);
  await playing(page, 4);
  expect([...counts.values()].every(count => count >= 2)).toBe(true);
  await expect(page.getByText('Chưa kết nối được camera.', { exact: true })).toHaveCount(0);
});

test('failed camera keeps its video element, stops retrying after three attempts and can recover while paused', async ({ page }) => {
  let offline = true;
  await setup(page, () => offline);
  await expect(page.getByRole('button', { name: 'Thử lại camera', exact: true })).toHaveCount(4, { timeout: 15000 });
  await expect(page.locator('video')).toHaveCount(4);
  await page.getByRole('button', { name: 'Tạm dừng tất cả camera', exact: true }).click();
  offline = false;
  await page.getByRole('button', { name: 'Thử lại camera', exact: true }).first().click();
  await expect.poll(() => page.locator('video').first().evaluate(element => {
    const video = element as HTMLVideoElement;
    return video.readyState >= 2 && video.paused && !video.error;
  })).toBe(true);
  await page.getByRole('button', { name: 'Phát tất cả camera', exact: true }).click();
  await expect.poll(() => page.locator('video').first().evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
});

test('refresh reloads all failed cameras and layouts one, four and nine show actual frames', async ({ page }) => {
  let offline = true;
  await setup(page, () => offline);
  await expect(page.getByRole('button', { name: 'Thử lại camera', exact: true })).toHaveCount(4, { timeout: 15000 });
  offline = false;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await playing(page, 4);
  await page.getByTitle('Một camera', { exact: true }).click();
  await playing(page, 1);
  await page.getByTitle('Chín camera', { exact: true }).click();
  await playing(page, 9);
  await page.getByTitle('Bốn camera', { exact: true }).click();
  await playing(page, 4);
});

test('native browser cache can transition from plain Demo preload to CORS streams and snapshots', async ({ page }) => {
  test.skip(!fs.existsSync(auditFile), 'Prepare demo playback copies first.');
  // Do not route/intercept network: Playwright routing disables the HTTP cache
  // and would conceal the actual CORS regression.
  const videos = JSON.parse(fs.readFileSync(auditFile, 'utf8')).filter((video: { filename: string }) =>
    ['0_tr10.mp4', '3_tr39.mp4', '2_te3.mp4', '1_tr25.mp4'].includes(video.filename));
  const sources = videos.map((video: { stream_url: string }) => {
    const url = new URL(video.stream_url, 'http://localhost:8000');
    url.searchParams.set('cors', '1');
    return url.href;
  });
  await page.goto('/');
  for (const cors of [false, true]) {
    await page.evaluate(({ sources, cors }) => {
      document.querySelectorAll('.cache-probe').forEach(element => element.remove());
      for (const source of sources) {
        const video = document.createElement('video');
        video.className = 'cache-probe'; video.muted = true; video.autoplay = true; video.preload = 'auto';
        if (cors) video.crossOrigin = 'anonymous';
        video.src = source; document.body.appendChild(video);
      }
    }, { sources, cors });
    await expect.poll(() => page.locator('.cache-probe').evaluateAll(elements => elements.every(element => {
      const video = element as HTMLVideoElement;
      return video.readyState >= 2 && !video.error;
    }))).toBe(true);
  }
  const snapshot = await page.locator('.cache-probe').first().evaluate(element => {
    const video = element as HTMLVideoElement, canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png').startsWith('data:image/png;');
  });
  expect(snapshot).toBe(true);
});

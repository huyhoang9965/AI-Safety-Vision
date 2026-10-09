import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import presets from '../lib/demo-camera-presets.json';

const auditFile = path.resolve('..', 'storage', 'outputs', 'playback-audit.json');

test('all 13 clips play from actual API without stalls or excessive dropped frames', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  test.skip(!fs.existsSync(auditFile), 'Run backend/scripts/prepare_demo_playback.py with the local backend running.');
  const videos = JSON.parse(fs.readFileSync(auditFile, 'utf8')) as { id: number; filename: string; stream_url: string }[];
  const user = { id: 'playback-test', full_name: 'Kiểm tra phát video', email: 'playback@example.test',
    memberships: [{ organization_id: 'test-org', permissions: ['camera.view'] }] };
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  const mediaResponses: { status: number; bytes: string | undefined }[] = [];
  page.on('response', response => {
    if (/\/api\/videos\/\d+\/stream/.test(response.url())) mediaResponses.push({ status: response.status(), bytes: response.headers()['content-range'] });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (/\/api\/videos\/\d+\/stream/.test(pathname)) {
      await route.continue(); // Actual FileResponse, range requests and prepared MP4 bytes.
      return;
    }
    const payload = pathname === '/api/auth/me' ? user : pathname === '/api/videos/test' ? videos
      : pathname === '/api/models' ? [] : pathname === '/api/health' ? { status: 'ok', database: 'connected' } : null;
    if (!payload) throw new Error('Unexpected request ' + pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/demo');
  const results = [];
  for (const preset of presets) {
    await page.getByRole('tab', { name: new RegExp(preset.key) }).click();
    for (let index = 0; index < preset.filenames.length; index++) {
      await page.getByRole('combobox', { name: 'Chọn tình huống camera' }).selectOption(String(index));
      const video = page.locator('.camera-stage video');
      const item = videos.find(item => item.filename === preset.filenames[index])!;
      await expect(video).toHaveAttribute('src', new RegExp('/api/videos/' + item.id + '/stream'));
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime), { timeout: 15000 }).toBeGreaterThan(.1);
      const before = await video.evaluate(element => {
        const media = element as HTMLVideoElement;
        (media as HTMLVideoElement & { stalls: number }).stalls = 0;
        media.addEventListener('waiting', () => { (media as HTMLVideoElement & { stalls: number }).stalls++; });
        const quality = media.getVideoPlaybackQuality();
        return { time: media.currentTime, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
      });
      await page.waitForTimeout(1800); // Measure uninterrupted real-time playback, not mocked timestamps.
      const after = await video.evaluate(element => {
        const media = element as HTMLVideoElement;
        const quality = media.getVideoPlaybackQuality();
        return { time: media.currentTime, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames,
          stalls: (media as HTMLVideoElement & { stalls: number }).stalls, width: media.videoWidth };
      });
      const frames = after.total - before.total, dropped = after.dropped - before.dropped;
      results.push({ camera: preset.key, filename: item.filename, advanced: after.time - before.time, frames, dropped, stalls: after.stalls, width: after.width });
      expect(after.width, item.filename).toBeLessThanOrEqual(1280);
      expect(after.time - before.time, item.filename).toBeGreaterThan(1.35);
      expect(frames, item.filename).toBeGreaterThan(25);
      expect(dropped / Math.max(1, frames), item.filename).toBeLessThan(.10);
      expect(after.stalls, item.filename).toBe(0);
      await video.evaluate(element => (element as HTMLVideoElement).pause());
    }
  }
  expect(results).toHaveLength(13);
  expect(mediaResponses.some(response => response.status === 206 && response.bytes)).toBe(true);
  expect(mediaResponses.every(response => [200, 206].includes(response.status))).toBe(true);
  await testInfo.attach('actual-playback-metrics.json', { body: JSON.stringify({ results, mediaResponses }, null, 2), contentType: 'application/json' });
  fs.writeFileSync(path.resolve('..', 'storage', 'outputs', 'actual-playback-metrics.json'), JSON.stringify({ results, mediaResponses }, null, 2));
});

test('nine simultaneous live cameras use range streams and all pause, resume and capture correctly', async ({ page }) => {
  test.setTimeout(60000);
  // Keep every camera visible during the measurement; browsers intentionally
  // skip painting videos scrolled off screen after clicking player controls.
  await page.setViewportSize({ width: 1440, height: 1100 });
  test.skip(!fs.existsSync(auditFile), 'Prepare demo playback copies first.');
  const videos = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
  const user = { id: 'live-playback-test', full_name: 'Kiểm tra giám sát', email: 'live@example.test',
    memberships: [{ organization_id: 'test-org', role_name: 'Quản trị viên', permissions: ['dashboard.view', 'camera.view', 'event.view'] }] };
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (/\/api\/videos\/\d+\/stream/.test(pathname)) { await route.continue(); return; }
    const payload = pathname === '/api/auth/me' ? user : pathname === '/api/videos/test' ? videos
      : pathname === '/api/models' ? [] : pathname === '/api/health' ? { status: 'ok' }
      : pathname === '/api/alerts' ? { items: [], total: 0, limit: 5, offset: 0, summary: { overdue: 0 }, filters: {} } : null;
    if (!payload) throw new Error('Unexpected request ' + pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/dashboard/live');
  await page.getByTitle('Chín camera', { exact: true }).click();
  const players = page.locator('video');
  await expect(players).toHaveCount(9);
  await expect.poll(() => players.evaluateAll(elements => elements.every(element => {
    const media = element as HTMLVideoElement;
    return media.videoWidth > 0 && media.videoWidth <= 1280 && media.currentTime > .1 && !media.paused;
  })), { timeout: 15000 }).toBe(true);
  expect(await players.evaluateAll(elements => elements.every(element => !(element as HTMLVideoElement).src.startsWith('blob:')))).toBe(true);
  await page.getByRole('button', { name: 'Tạm dừng tất cả camera', exact: true }).click();
  await expect.poll(() => players.evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).paused))).toBe(true);
  await page.getByRole('button', { name: 'Phát tất cả camera', exact: true }).click();
  await expect.poll(() => players.evaluateAll(elements => elements.every(element => !(element as HTMLVideoElement).paused))).toBe(true);
  await page.waitForTimeout(1800);
  const qualities = await players.evaluateAll(elements => elements.map(element => {
    const quality = (element as HTMLVideoElement).getVideoPlaybackQuality();
    return { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
  }));
  for (const quality of qualities) {
    expect(quality.total).toBeGreaterThan(25);
    expect(quality.dropped / quality.total).toBeLessThan(.10);
  }
  fs.writeFileSync(path.resolve('..', 'storage', 'outputs', 'live-playback-metrics.json'), JSON.stringify(qualities, null, 2));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Chụp ảnh', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^CAM-01-.*\.png$/);
});

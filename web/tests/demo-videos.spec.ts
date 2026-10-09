import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import presets from '../lib/demo-camera-presets.json';
import { cameraDemoVideo } from '../lib/demo-cameras';
import { visibleBoxes } from '../components/dashboard/detection-overlay';

async function setup(page: Page, safeResults = false, options: { unverified?: boolean; ppe?: boolean; ppeBoth?: boolean } = {}) {
  const user = { id: 'demo-test-user', full_name: 'Kiểm tra demo', email: 'demo@example.test',
    memberships: [{ organization_id: 'test-org', is_default: true, permissions: ['dashboard.view', 'camera.view'] }] };
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1', JSON.stringify({
    access_token: 'test-only', refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600, user,
  })), user);
  const labels: Record<string, string> = { 'CAM-01': 'Safe Walkway Violation', 'CAM-02': 'Carrying Overload with Forklift',
    'CAM-03': 'Opened Panel Cover', 'CAM-04': 'Unauthorized Intervention', 'CAM-05': 'Safe Walkway Violation' };
  const videos = presets.flatMap(preset => preset.filenames.map((filename, index) => ({
    id: 1000 + presets.indexOf(preset) * 10 + index, filename, labels: [filename === '7_tr19.mp4' ? 'Safe Carrying' : labels[preset.key]],
    width: 1920, height: 1080,
    stream_url: '/api/videos/' + (1000 + presets.indexOf(preset) * 10 + index) + '/stream',
  })));
  const requests: { video_id: number; model_name: string; camera_code: string }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let payload: unknown;
    if (pathname === '/api/auth/me') payload = user;
    else if (pathname === '/api/videos/test') payload = [...videos].reverse(); // IDs/order must never choose the clip.
    else if (pathname === '/api/models') payload = ['VideoMAE', 'RF-DETR'].map(name => ({ name, connected: true, loaded: true }));
    else if (pathname === '/api/health') payload = { status: 'ok', database: 'connected' };
    else if (pathname === '/api/inference') {
      expect(request.headers().authorization).toBe('Bearer test-only');
      const body = request.postDataJSON(); requests.push(body);
      const video = videos.find(item => item.id === body.video_id)!;
      const prediction = body.model_name === 'RF-DETR' ? 'person' : safeResults ? 'Safe Walkway' : video.labels[0];
      const behavior = body.model_name === 'VideoMAE' && !['Safe Walkway','Safe Carrying'].includes(prediction);
      const ppe = Boolean(body.model_name === 'RF-DETR' && ((options.ppe && body.camera_code === 'CAM-02') || (options.ppeBoth && ['CAM-03','CAM-04'].includes(body.camera_code))));
      const className = ppe ? 'Suspected no helmet' : prediction;
      const evidence = behavior || ppe ? [{ class_name: className, verified: !options.unverified,
        track_id: 1, frame_index: 25, timestamp_seconds: 1, image: `/api/videos/${video.id}/thumbnail?frame_index=25`,
        bbox: [600,250,1200,900] }] : [];
      const overlays = (behavior && !options.unverified) || ppe
        ? [1,1.25,1.5,1.75,2].map(timestamp_seconds => ({ class_name: className, track_id: 1, timestamp_seconds, bbox: [600,250,1200,900] })) : [];
      if (ppe && options.ppeBoth) {
        evidence.push({ ...evidence[0], class_name: 'Suspected no vest', bbox: [600,400,1200,800] });
        overlays.push(...[1,1.25,1.5,1.75,2].map(timestamp_seconds => ({ class_name: 'Suspected no vest', track_id: 1, timestamp_seconds, bbox: [600,400,1200,800] })));
      }
      payload = { video_id: video.id, model: body.model_name, prediction, confidence: .96,
        persisted: true, event_ids: evidence.map(event => 'test-event-' + body.model_name + '-' + video.id + '-' + event.class_name),
        output_video: ppe ? '/results/ppe-processed.mp4' : video.stream_url,
        metrics: { evidence_events: evidence, overlay_frames: overlays, frame_width: 1920, frame_height: 1080 } };
    } else if (/\/api\/videos\/\d+\/stream/.test(pathname)) {
      const video = videos.find(item => item.id === Number(pathname.split('/')[3]))!;
      const auditPath = path.resolve('..', 'storage', 'outputs', 'playback-audit.json');
      const prepared = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath, 'utf8')).find((item: { filename: string }) => item.filename === video.filename)?.preview_path : null;
      await route.fulfill({ contentType: 'video/mp4', path: prepared || path.resolve('..', 'Datasets', 'Safe_Unsafe', 'data', video.filename) });
      return;
    } else if (/\/api\/videos\/\d+\/thumbnail/.test(pathname)) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7D8AAAAASUVORK5CYII=', 'base64') });
      return;
    } else throw new Error('Unexpected API request ' + pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/demo');
  await expect.poll(() => requests.length, { timeout: 20000 }).toBe(videos.length * 2);
  return { requests, videos, errors };
}

test('all curated clips are analyzed once and behavior results precede PPE', async ({ page }) => {
  const { requests, videos, errors } = await setup(page);
  expect(requests.slice(0, videos.length).every(item => item.model_name === 'VideoMAE')).toBe(true);
  expect(requests.slice(videos.length).every(item => item.model_name === 'RF-DETR')).toBe(true);
  expect(new Set(requests.map(item => item.camera_code + ':' + item.video_id + ':' + item.model_name)).size).toBe(videos.length * 2);
  await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('new scenarios can be selected directly and native video playback works', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const { videos } = await setup(page);
  for (const preset of presets.filter(item => item.filenames.length >= 3)) {
    await page.getByRole('tab', { name: new RegExp(preset.key) }).click();
    const select = page.getByRole('combobox', { name: 'Chọn tình huống camera' });
    await select.selectOption('2');
    await expect(select).toHaveValue('2');
    const video = page.locator('.camera-stage video');
    const expectedVideo = videos.find(item => item.filename === preset.filenames[2])!;
    await expect(video).toHaveAttribute('src', new RegExp('/api/videos/' + expectedVideo.id + '/stream'));
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
    await video.evaluate(element => (element as HTMLVideoElement).pause());
    await page.screenshot({ path: testInfo.outputPath('new-case-' + preset.key + '.png') });
  }
});

test('unsafe dataset labels never force an alert when the model returns a safe result', async ({ page }) => {
  await setup(page, true);
  await expect(page.locator('.alert-item')).toHaveCount(0);
  await expect(page.locator('.violation-roi')).toHaveCount(0);
  await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible();
});

test('scenario selector fits a mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const select = page.getByRole('combobox', { name: 'Chọn tình huống camera' });
  const layout = await select.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth }; });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
});

test('camera previews and live streams use curated filenames even when catalog IDs and order change', () => {
  const filenames = presets.flatMap(preset => preset.filenames);
  const catalog = [{ id: 1, filename: 'unreviewed-low-confidence.mp4' },
    ...filenames.map((filename, index) => ({ id: 900 - index, filename }))].reverse();
  for (let index = 1; index <= 9; index++) {
    const video = cameraDemoVideo(catalog, 'CAM-0' + index);
    expect(video).toBeDefined();
    expect(filenames).toContain(video!.filename);
    expect(video!.id).not.toBe(1);
  }
  expect(cameraDemoVideo([{ id: 1, filename: 'unreviewed-low-confidence.mp4' }], 'CAM-01')).toBeUndefined();
});

test('unverified unsafe classification never paints a camera ROI or publishes an alert', async ({ page }) => {
  await setup(page, false, { unverified: true });
  await expect(page.locator('.alert-item')).toHaveCount(0);
  await expect(page.locator('.violation-roi')).toHaveCount(0);
  await expect(page.getByTestId('detection-box')).toHaveCount(0);
});

test('late PPE results keep original video and both actual object overlays', async ({ page }) => {
  test.setTimeout(60000);
  const { videos } = await setup(page, false, { ppe: true });
  await page.getByRole('tab', { name: /CAM-02/ }).click();
  await page.getByRole('combobox', { name: 'Chọn tình huống camera' }).selectOption('0');
  const video = page.locator('.camera-stage video');
  // Control only the playback clock for deterministic overlay synchronization;
  // source selection and decoding actual MP4 metadata are tested separately.
  await video.evaluate(el => { const video = el as HTMLVideoElement; video.pause();
    Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:1.5});
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByTestId('detection-box')).toHaveCount(2);
  await expect(video).toHaveAttribute('src', new RegExp('/api/videos/' + videos.find(v => v.filename === presets[1].filenames[0])!.id + '/stream'));
  await video.evaluate(el => { (el as HTMLVideoElement).currentTime = 3; el.dispatchEvent(new Event('timeupdate')); });
  await expect(page.getByTestId('detection-box')).toHaveCount(0);
});

test('CAM-03 and CAM-04 distinguish helmet, vest and opened panel with Vietnamese labels', async ({ page }) => {
  await setup(page, false, { ppeBoth: true });
  for (const camera of ['CAM-03','CAM-04']) {
    await page.getByRole('tab', { name: new RegExp(camera) }).click();
    await page.getByRole('combobox', { name: 'Chọn tình huống camera' }).selectOption('0');
    await page.locator('.camera-stage video').evaluate(el => {
      const video = el as HTMLVideoElement; video.pause();
      Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:1.5});
      video.dispatchEvent(new Event('timeupdate'));
    });
    const helmet = page.locator('[data-testid="detection-box"][data-label="Suspected no helmet"]');
    const vest = page.locator('[data-testid="detection-box"][data-label="Suspected no vest"]');
    await expect(helmet.locator('rect')).toHaveAttribute('stroke','#ef4444');
    await expect(vest.locator('rect')).toHaveAttribute('stroke','#f59e0b');
    await expect(helmet.locator('text')).toHaveText('Nghi không đội mũ');
    await expect(vest.locator('text')).toHaveText('Nghi thiếu áo bảo hộ');
    if (camera === 'CAM-03') {
      await expect(page.locator('[data-label="Opened Panel Cover"] rect')).toHaveAttribute('stroke','#a855f7');
      await expect(page.locator('.camera-caption')).toContainText('Nắp tủ điện đang mở');
    }
  }
  await expect(page.locator('[aria-label="Chú thích màu cảnh báo"]')).toBeVisible();
});

test('small evidence is never enlarged and reload does not repeat notifications', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  const image = page.locator('.evidence-media img');
  await expect(image).toBeVisible();
  const sizes = await image.evaluate(el => { const img=el as HTMLImageElement; const box=img.getBoundingClientRect();return { w:box.width,h:box.height,nw:img.naturalWidth,nh:img.naturalHeight }; });
  expect(sizes.w).toBeLessThanOrEqual(sizes.nw);
  expect(sizes.h).toBeLessThanOrEqual(sizes.nh);
  const count = await page.locator('.alert-item').count();
  await page.reload();
  await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.alert-item')).toHaveCount(count);
  await expect(page.locator('.alert-toast')).toHaveCount(0);
});

test('corrected analysis removes obsolete vest warnings from session history even if previously acknowledged', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('ai-safety-alert-history-grounded-v2:demo-test-user',JSON.stringify([
      {id:'old-false-vest',camera:'CAM-03',videoId:1021,type:'ppe',title:'Cảnh báo áo cũ cần loại bỏ',rawLabel:'Suspected no vest',
       status:'Đã xác nhận',savedToDashboard:true,eventId:'old-false-vest',personId:1,model:'RF-DETR',
       severity:{label:'Cần kiểm tra',tone:'high'},confidence:null,location:'Khu kỹ thuật',time:'10:00:00',date:'08/10/2026',
       image:'',detail:'Old detector dropout',timestampSeconds:3.5,frameIndex:84},
      {id:'different-clip',camera:'CAM-03',videoId:9999,type:'ppe',title:'Lịch sử clip khác vẫn giữ',rawLabel:'Suspected no helmet',
       status:'Cần xác minh',savedToDashboard:true,eventId:'different-clip',personId:2,model:'RF-DETR',
       severity:{label:'Cần kiểm tra',tone:'high'},confidence:null,location:'Khu kỹ thuật',time:'10:00:00',date:'08/10/2026',
       image:'',detail:'Different clip',timestampSeconds:1,frameIndex:25}
    ]));
  });
  await setup(page,true);
  await expect(page.getByText('Đã hoàn tất',{exact:true})).toBeVisible();
  await expect(page.getByText('Cảnh báo áo cũ cần loại bỏ',{exact:true})).toHaveCount(0);
  await expect(page.locator('.alert-item').getByText('Lịch sử clip khác vẫn giữ',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('ai-safety-alert-history-grounded-v2:demo-test-user')||'[]').map((a:{id:string})=>a.id))).toEqual(['different-clip']);
});

test('object overlays interpolate tracked boxes and disappear on absent frames and seek backwards', () => {
  const rows=[{class_name:'vehicle',track_id:1,timestamp_seconds:1,bbox:[10,20,110,120]},
    {class_name:'vehicle',track_id:1,timestamp_seconds:1.25,bbox:[30,20,130,120]},
    {class_name:'vehicle',track_id:1,timestamp_seconds:3,bbox:[60,20,160,120]}];
  expect(visibleBoxes(rows,.5)).toEqual([]);
  expect(visibleBoxes(rows,1.125)[0].bbox).toEqual([20,20,120,120]);
  expect(visibleBoxes(rows,2)).toEqual([]);
  expect(visibleBoxes(rows,3)[0].bbox).toEqual([60,20,160,120]);
  expect(visibleBoxes(rows,1)[0].bbox).toEqual([10,20,110,120]);
});

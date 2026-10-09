import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('live analysis uses actual category boxes with original coordinates and preserves both model overlays', async ({ page }) => {
  const user = { id:'live-color-test', full_name:'Kiểm tra khung AI', memberships:[{organization_id:'test',permissions:['dashboard.view','camera.view','event.view']}] };
  const audit = JSON.parse(fs.readFileSync(path.resolve('..','storage','outputs','playback-audit.json'),'utf8'));
  const video = { ...audit.find((item: { filename: string }) => item.filename === '2_te3.mp4'), width:1920,height:1080 };
  await page.addInitScript(user => localStorage.setItem('ai-safety-auth-session-v1',JSON.stringify({ access_token:'test-only',refresh_token:'test-only',expires_in:3600,user })),user);
  await page.route('**/api/**',async route => {
    const url = new URL(route.request().url());let body;
    if(url.pathname==='/api/auth/me')body=user;
    else if(url.pathname==='/api/videos/test')body=[video];
    else if(url.pathname==='/api/models')body=['RF-DETR','VideoMAE'].map(name=>({name,connected:true,loaded:true,type:name==='RF-DETR'?'detection':'classification'}));
    else if(url.pathname==='/api/alerts')body={items:[],total:0,summary:{overdue:0}};
    else if(url.pathname==='/api/health')body={status:'ok'};
    else if(url.pathname.endsWith('/stream')){await route.fulfill({contentType:'video/mp4',path:video.preview_path});return;}
    else if(url.pathname==='/api/inference'){
      const request=route.request().postDataJSON();
      expect(request.camera_code).toBe('CAM-03');
      const names=request.model_name==='RF-DETR'?['Suspected no helmet','Suspected no vest']:['Opened Panel Cover'];
      body={video_id:video.id,model:request.model_name,prediction:names[0],confidence:.99,persisted:true,event_ids:names,violations_saved:0,
        metrics:{frame_width:1920,frame_height:1080,evidence_events:names.map(class_name=>({class_name,track_id:1,confidence:.99})),
          overlay_frames:names.map((class_name,index)=>({class_name,track_id:1,timestamp_seconds:0,end_seconds:1.75,bbox:[100+index*200,100,200+index*200,250]}))}};
    }else throw new Error('Unexpected API '+url.pathname);
    await route.fulfill({json:body});
  });
  await page.goto('/dashboard/live');
  await page.getByRole('button',{name:/CAM-03 · Tủ điện máy ép/}).click();
  await page.getByRole('button',{name:'Phân tích AI',exact:true}).click();
  await expect(page.getByText('Đã hoàn tất phân tích CAM-03, không có vi phạm mới.')).toBeVisible();
  const player=page.locator('video').first();
  await player.evaluate(el=>{const video=el as HTMLVideoElement;video.pause();Object.defineProperty(video,'currentTime',{configurable:true,writable:true,value:.75});video.dispatchEvent(new Event('timeupdate'));});
  await expect(page.getByTestId('detection-box')).toHaveCount(3);
  await expect(page.locator('[data-label="Suspected no helmet"] rect')).toHaveAttribute('stroke','#ef4444');
  await expect(page.locator('[data-label="Suspected no vest"] rect')).toHaveAttribute('stroke','#f59e0b');
  await expect(page.locator('[data-label="Opened Panel Cover"] rect')).toHaveAttribute('stroke','#a855f7');
  await expect(page.locator('[aria-label="Khung đối tượng AI phát hiện"]')).toHaveAttribute('viewBox','0 0 1920 1080');
  const labelSize=await page.locator('[data-label="Suspected no helmet"] text').evaluate(el=>el.getBoundingClientRect().height);
  expect(labelSize).toBeGreaterThanOrEqual(11);
  await page.getByTitle('Bật/tắt lớp AI').click();await expect(page.getByTestId('detection-box')).toHaveCount(0);
  await page.getByTitle('Bật/tắt lớp AI').click();
  await player.evaluate(el=>{(el as HTMLVideoElement).currentTime=3;el.dispatchEvent(new Event('timeupdate'));});
  await expect(page.getByTestId('detection-box')).toHaveCount(0);
});

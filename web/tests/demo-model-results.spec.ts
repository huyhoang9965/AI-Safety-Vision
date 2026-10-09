import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('real checkpoint results show foreground helmet and vest warnings together with the actual cabinet aperture', async ({ page }) => {
  test.skip(process.env.TEST_REAL_MODEL_RESULTS !== '1','Run local checkpoint audits before opting in.');
  await page.setViewportSize({width:1280,height:1200});
  const output = path.resolve('..','storage','outputs');
  const ppe = JSON.parse(fs.readFileSync(path.join(output,'ppe-panel-review','ppe-audit.json'),'utf8'));
  const panels = JSON.parse(fs.readFileSync(path.join(output,'demo-video-review','behavior-verification.json'),'utf8')).videos;
  const videos = JSON.parse(fs.readFileSync(path.join(output,'playback-audit.json'),'utf8'));
  const user={id:'real-review',full_name:'Kiểm tra mô hình',memberships:[{organization_id:'test',permissions:['dashboard.view','camera.view']}]};
  const analyzed = new Set<string>();
  await page.addInitScript(user=>localStorage.setItem('ai-safety-auth-session-v1',JSON.stringify({access_token:'test-only',refresh_token:'test-only',expires_in:3600,user})),user);
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());let body;
    if(url.pathname==='/api/auth/me')body=user;
    else if(url.pathname==='/api/health')body={status:'ok',database:'connected'};
    else if(url.pathname==='/api/videos/test')body=videos;
    else if(url.pathname==='/api/models')body=['RF-DETR','VideoMAE'].map(name=>({name,connected:true,loaded:true}));
    else if(url.pathname==='/api/inference'){
      const request=route.request().postDataJSON(),video=videos.find((item:{id:number})=>item.id===request.video_id);
      const measured=request.model_name==='RF-DETR'?ppe.find((item:{filename:string})=>item.filename===video.filename):panels.find((item:{filename:string})=>item.filename===video.filename);
      const metrics=request.model_name==='RF-DETR'?measured?.metrics:measured?{...measured,frame_width:1920,frame_height:1080}:null;
      body={video_id:video.id,model:request.model_name,prediction:request.model_name==='VideoMAE'?(measured?.prediction||'Safe Walkway'):'Person',
        confidence:measured?.confidence||.99,persisted:true,reused:true,new_event_ids:[],event_ids:(metrics?.evidence_events||[]).map((_:unknown,index:number)=>`review-${request.model_name}-${video.id}-${index}`),
        output_video:video.stream_url,metrics:metrics||{evidence_events:[],overlay_frames:[]}};
      analyzed.add(request.camera_code+':'+request.model_name);
      analyzed.add(request.camera_code+':'+video.filename+':'+request.model_name);
    }else if(url.pathname.endsWith('/stream')){
      const video=videos.find((item:{id:number})=>item.id===Number(url.pathname.split('/')[3]));
      const bytes=fs.readFileSync(video.preview_path),range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      if(range){
        const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):bytes.length-1,bytes.length-1);
        await route.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${bytes.length}`},body:bytes.subarray(start,end+1)});
      }else await route.fulfill({contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:bytes});
      return;
    }else if(url.pathname.includes('/thumbnail')){
      await route.fulfill({contentType:'image/jpeg',path:path.join(output,'ppe-panel-review','2_te3.mp4.jpg')});return;
    }else throw new Error('Unexpected API '+url.pathname);
    await route.fulfill({json:body});
  });
  await page.route('**/results/**',async route=>{
    const filename=path.basename(new URL(route.request().url()).pathname);
    const audited=path.join(output,'ppe-panel-review',filename);
    await route.fulfill({contentType:'image/jpeg',path:fs.existsSync(audited)?audited:path.join(output,filename)});
  });
  await page.goto('/demo');
  await expect.poll(()=>analyzed.has('CAM-03:RF-DETR')&&analyzed.has('CAM-04:RF-DETR')).toBe(true);
  for(const camera of ['CAM-03','CAM-04']){
    await page.getByRole('tab',{name:new RegExp(camera)}).click();
    await page.getByRole('combobox',{name:'Chọn tình huống camera'}).selectOption('0');
    const video=page.locator('.camera-stage video');
    const time=camera==='CAM-04'?3.5:3;
    await expect.poll(()=>video.evaluate(el=>{const video=el as HTMLVideoElement;return video.buffered.length?video.buffered.end(video.buffered.length-1):0;})).toBeGreaterThan(time);
    await video.evaluate((el,time)=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.pause();video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=time;}),time);
    await expect.poll(()=>video.evaluate(el=>(el as HTMLVideoElement).currentTime)).toBeCloseTo(time,1);
    await expect(page.locator('[data-label="Suspected no helmet"]')).not.toHaveCount(0);
    if(camera==='CAM-03'){
      await expect(page.locator('[data-label="Suspected no vest"]')).not.toHaveCount(0);
      await expect(page.locator('[data-label="Opened Panel Cover"]')).toHaveCount(1);
      const head=page.locator('[data-label="Suspected no helmet"]').filter({has:page.locator('rect[x]')});
      const positions=await head.locator('rect').evaluateAll(elements=>elements.map(el=>Number(el.getAttribute('x'))));
      expect(positions.some(x=>x>800)).toBe(true); // The moving worker in front of the machine, not only the distant worker.
    }else{
      await expect.poll(async()=>{
        const x=await page.locator('[data-label="Suspected no helmet"] rect').evaluateAll(elements=>elements.map(el=>Number(el.getAttribute('x'))));
        return x.some(v=>v>390&&v<475)&&x.some(v=>v>510&&v<610);
      }).toBe(true); // Both occluded workers, independently localized.
    }
    await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review',camera+'-actual-overlay.png')});
  }
  // The cabinet worker was missed by the full-frame pass. At six seconds the
  // open aperture and this worker's head must both be independently visible.
  const cam4Video=page.locator('.camera-stage video');
  await cam4Video.evaluate(el=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.pause();video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=6;}));
  await expect(page.locator('[data-label="Opened Panel Cover"]')).toHaveCount(1);
  await expect.poll(async()=>{
    const heads=await page.locator('[data-label="Suspected no helmet"] rect').evaluateAll(elements=>elements.map(el=>({x:Number(el.getAttribute('x')),y:Number(el.getAttribute('y'))})));
    return heads.some(box=>box.x>550&&box.x<780&&box.y>850&&box.y<1000);
  }).toBe(true);
  await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review','CAM-04-cabinet-worker.png')});
  await cam4Video.evaluate(el=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=14;}));
  const fixtureWarning=await page.locator('[data-label="Suspected no helmet"] rect,[data-label="Suspected no vest"] rect').evaluateAll(elements=>elements.some(el=>Number(el.getAttribute('x'))>1700&&Number(el.getAttribute('y'))>600&&Number(el.getAttribute('y'))<900));
  expect(fixtureWarning).toBe(false);
  await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review','CAM-04-fixture-filtered.png')});
  await page.getByRole('combobox',{name:'Chọn tình huống camera'}).selectOption('1');
  await expect.poll(()=>analyzed.has('CAM-04:1_te9.mp4:VideoMAE')).toBe(true);
  await expect.poll(()=>cam4Video.evaluate(el=>{const video=el as HTMLVideoElement;return video.buffered.length?video.buffered.end(video.buffered.length-1):0;})).toBeGreaterThan(6);
  await cam4Video.evaluate(el=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.pause();video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=6;}));
  await expect(page.locator('[data-label="Opened Panel Cover"]')).toHaveCount(1);
  await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review','CAM-04-second-cabinet.png')});
  await expect.poll(()=>analyzed.has('CAM-03:2_tr14.mp4:RF-DETR')).toBe(true);
  await page.getByRole('tab',{name:/CAM-03/}).click();
  await page.getByRole('combobox',{name:'Chọn tình huống camera'}).selectOption('1');
  const video=page.locator('.camera-stage video');
  await expect.poll(()=>video.evaluate(el=>{const video=el as HTMLVideoElement;return video.buffered.length?video.buffered.end(video.buffered.length-1):0;})).toBeGreaterThan(3.5);
  await video.evaluate(el=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.pause();video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=3.5;}));
  await expect.poll(()=>video.evaluate(el=>(el as HTMLVideoElement).currentTime)).toBeCloseTo(3.5,1);
  const clip2=ppe.find((item:{filename:string})=>item.filename==='2_tr14.mp4');
  const wearer=clip2.detections.find((item:{class_name:string;x1:number;x2:number})=>item.class_name==='Vest'&&item.x1>1300&&item.x2<1410);
  expect(wearer).toBeTruthy();
  expect(clip2.evidence_events.some((item:{class_name:string;track_id:number})=>item.class_name==='Suspected no vest'&&String(item.track_id)===String(wearer.track_id))).toBe(false);
  // A worn reflective vest must not get a yellow warning. Helmet absence for
  // that same person and separate workers' vest warnings remain independent.
  await expect.poll(async()=>{
    const positions=await page.locator('[data-label="Suspected no helmet"] rect').evaluateAll(elements=>elements.map(el=>Number(el.getAttribute('x'))));
    return positions.some(x=>x>1300&&x<1410);
  }).toBe(true);
  const falseVest=await page.locator('[data-label="Suspected no vest"] rect').evaluateAll(elements=>elements.some(el=>{const x=Number(el.getAttribute('x'));return x>1300&&x<1410;}));
  expect(falseVest).toBe(false);
  await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review','CAM-03-vest-correction.png')});
  await page.getByRole('tab',{name:/CAM-05/}).click();
  await page.getByRole('combobox',{name:'Chọn tình huống camera'}).selectOption('2');
  await expect.poll(()=>analyzed.has('CAM-05:0_tr79.mp4:RF-DETR')).toBe(true);
  await expect.poll(()=>video.evaluate(el=>{const video=el as HTMLVideoElement;return video.buffered.length?video.buffered.end(video.buffered.length-1):0;})).toBeGreaterThan(3);
  await video.evaluate(el=>new Promise<void>(resolve=>{const video=el as HTMLVideoElement;video.pause();video.addEventListener('seeked',()=>resolve(),{once:true});video.currentTime=3;}));
  const cam5=ppe.find((item:{filename:string})=>item.filename==='0_tr79.mp4');
  const missingHelmet=cam5.metrics.evidence_events.find((item:{class_name:string;bbox:number[]})=>item.class_name==='Suspected no helmet'&&item.bbox[0]>380&&item.bbox[0]<480&&item.bbox[1]>350&&item.bbox[1]<440);
  expect(missingHelmet).toBeTruthy();
  expect(cam5.metrics.evidence_events.some((item:{class_name:string;track_id:number})=>item.class_name==='Suspected no vest'&&String(item.track_id)===String(missingHelmet.track_id))).toBe(true);
  for(const label of ['Suspected no helmet','Suspected no vest']){
    await expect.poll(async()=>{
      const boxes=await page.locator(`[data-label="${label}"] rect`).evaluateAll(elements=>elements.map(el=>({x:Number(el.getAttribute('x')),y:Number(el.getAttribute('y'))})));
      return boxes.some(box=>box.x>380&&box.x<480&&box.y>350&&box.y<520);
    }).toBe(true);
  }
  await page.locator('.camera-stage').screenshot({path:path.join(output,'ppe-panel-review','CAM-05-third-worker.png')});
});

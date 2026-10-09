import { test, expect, type Page } from '@playwright/test';

const user = { id:'metrics-test',full_name:'Kiểm Tra Thống Kê',email:'metrics@example.test',
  memberships:[{organization_id:'test-org',role_name:'Quản trị viên',permissions:['dashboard.view','camera.manage']}] };
const model = { code:'RF_DETR',name:'RF-DETR',version:'1.0',type:'detection',framework:'PyTorch',connected:true,
  loaded:true,status:'ready',artifact_name:'test.pth',artifact_size_bytes:1024,labels:[],active_deployments:0,camera_coverage:0,
  stats:{total_runs:0,completed_runs:0,failed_runs:0,average_processing_seconds:null,last_run_at:null,detections:0,violations:0,average_confidence:null} };
const management = { models:[model],deployments:[],cameras:[],recent_inferences:[],class_metrics:[],daily_metrics:[],
  summary:{total_models:1,connected_models:1,loaded_models:1,active_deployments:0,cameras_covered:0,runs_24h:0,failures_24h:0,average_processing_seconds:null} };
function metrics(empty=false) {
  return { period:'7d',available:true,configuration:{llm_model:'test-llm',tts_model:'test-tts',llm_configured:true,
    tts_enabled:true,retrieval_mode:'sql_tools',internal_data_shared:false},
    providers: empty ? [] : [{service:'llm',model:'test-llm',requests:5,completed:4,failed:1,rate_limited:1,
      p50_ms:1500,p95_ms:2200,p99_ms:2500,average_ms:1800,first_byte_p50_ms:null,first_byte_p99_ms:null,
      input_tokens:1200,output_tokens:300,cached_tokens:100,reasoning_tokens:20,token_samples:4,
      cost_usd:.001,priced_requests:4,input_characters:null,audio_seconds:null,rtf:null,tokens_per_second:12,
      usd_per_million_tokens:.66667,usd_per_thousand_characters:null,usd_per_audio_minute:null},
      {service:'tts',model:'test-tts',requests:2,completed:2,failed:0,rate_limited:0,p50_ms:800,p95_ms:1000,p99_ms:1100,
       average_ms:900,first_byte_p50_ms:200,first_byte_p99_ms:300,input_tokens:null,output_tokens:null,cached_tokens:null,
       reasoning_tokens:null,token_samples:0,cost_usd:null,priced_requests:0,input_characters:100,audio_seconds:5,
       rtf:.36,tokens_per_second:null,usd_per_million_tokens:null,usd_per_thousand_characters:null,usd_per_audio_minute:null}],
    daily: empty ? [] : [{day:'2026-10-08',service:'llm',requests:5,cost_usd:.001,unpriced_requests:1}],
    answers:{requests:20,p50_ms:1769.5,p95_ms:3200,p99_ms:4000,input_tokens:5000,output_tokens:1000,
      retrieval_answers:10,sourced_answers:8,feedback_samples:4,positive_feedback:3},
    rag:{requests:empty?0:12,completed:empty?0:11,failed:empty?0:1,p50_ms:empty?null:12,p95_ms:empty?null:24,
      p99_ms:empty?null:30,latency_samples:empty?0:11,result_samples:empty?0:10,empty_results:empty?0:2,average_results:empty?null:3} };
}
async function setup(page:Page, options:{empty?:boolean;fail?:boolean}={}) {
  const requests:URL[]=[];
  let fail=!!options.fail;
  await page.addInitScript(user=>localStorage.setItem('ai-safety-auth-session-v1',JSON.stringify({
    access_token:'test-only',refresh_token:'test-only',token_type:'bearer',expires_in:3600,user
  })),user);
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname!=='/api/health') expect(route.request().headers().authorization).toBe('Bearer test-only');
    let body;
    if(url.pathname==='/api/auth/me') body=user;
    else if(url.pathname==='/api/health') body={status:'ok'};
    else if(url.pathname==='/api/models/management') body=management;
    else if(url.pathname==='/api/models/assistant-metrics'){
      requests.push(url);
      if(fail){await route.fulfill({status:503,json:{detail:'Unavailable'}});return;}
      body={...metrics(options.empty),period:url.searchParams.get('period')};
    }else throw new Error('Unexpected API path '+url.pathname);
    await route.fulfill({json:body});
  });
  await page.goto('/dashboard/models');
  return {requests,recover:()=>{fail=false;},section:page.getByRole('region',{name:'Thống kê LLM RAG TTS'})};
}

test('shows measured percentiles, token costs, unavailable TTS billing and honest RAG quality status',async({page})=>{
  const {section}=await setup(page);
  await expect(section.getByRole('heading',{name:'LLM, RAG & giọng nói'})).toBeVisible();
  await expect(section.getByText('1.50 s',{exact:true})).toBeVisible();
  await expect(section.getByText('2.50 s',{exact:true})).toBeVisible();
  await expect(section.getByText('$0.0010',{exact:true}).first()).toBeVisible();
  await expect(section.getByText('0/2 lượt đã đối soát',{exact:true})).toBeVisible();
  await expect(section.getByText('0.36×',{exact:true})).toBeVisible();
  await expect(section.getByText('Recall@k · MRR · nDCG · Faithfulness',{exact:true})).toBeVisible();
  await expect(section.getByText(/Chưa có bộ truy vấn/)).toBeVisible();
  await expect(section).not.toContainText('NaN');
});

test('empty usage keeps historical answers without inventing free cost or zero latencies',async({page})=>{
  const {section}=await setup(page,{empty:true});
  await expect(section.getByText('Chưa có số liệu',{exact:true})).toBeVisible();
  await expect(section.getByText('1.77 s / 3.20 s / 4.00 s',{exact:true})).toBeVisible();
  await expect(section.getByText('$0.0000',{exact:true})).toHaveCount(0);
  await expect(section.getByText('0 ms',{exact:true})).toHaveCount(0);
  await expect(section).not.toContainText('NaN');
});

test('time filter reaches backend and CSV exports measured values',async({page})=>{
  const {section,requests}=await setup(page);
  await expect(section.getByText('0.36×',{exact:true})).toBeVisible();
  await section.getByLabel('Khoảng thời gian thống kê AI').selectOption('24h');
  await expect.poll(()=>requests.at(-1)?.searchParams.get('period')).toBe('24h');
  const downloaded=page.waitForEvent('download');
  await section.getByRole('button',{name:'CSV',exact:true}).click();
  const download=await downloaded;
  expect(download.suggestedFilename()).toBe('ai-usage-24h.csv');
  const stream=(await download.createReadStream())!;
  const chunks=[];for await(const chunk of stream) chunks.push(chunk);
  const csv=Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('"1500","2200","2500"');
  expect(csv).toContain('"Chi phí USD"');
  expect(csv).toContain('"tts","test-tts","2","0","800","1000","1100","","","","","","0"');
});

test('metrics outage does not hide camera models and can retry',async({page})=>{
  const {section,recover}=await setup(page,{fail:true});
  await expect(section.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Model Registry',{exact:true})).toBeVisible();
  recover();await section.getByRole('button',{name:'Thử lại',exact:true}).click();
  await expect(section.getByText('0.36×',{exact:true})).toBeVisible();
});

test('assistant metrics fit a mobile viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const {section}=await setup(page);
  await expect(section.getByText('0.36×',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:'../storage/outputs/assistant-metrics-mobile.png',fullPage:true});
});

'use client';

import {
  Activity, AlertTriangle, Building2, Camera, CheckCircle2, ChevronDown,
  ChevronRight, CircleDot, Cpu, Edit3, Eye, Filter, Gauge, Grid2X2,
  HardDrive, LayoutList, LoaderCircle, LockKeyhole, MapPin, MoreHorizontal,
  Network, Plus, Radio, RefreshCw, Search, Server, Settings2, ShieldCheck,
  Signal, Thermometer, Video, WifiOff, X, Zap,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { readAuthSession, userPermissions } from '@/lib/auth';
import styles from './cameras-management.module.css';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
type DeviceStatus = 'online' | 'offline' | 'warning' | 'maintenance' | 'disabled';
type Site = { id:string; code:string; name:string; address:string|null; latitude:number|null; longitude:number|null; timezone:string; is_active:boolean; zone_count:number; camera_count:number };
type Zone = { id:string; site_id:string; site_code:string; code:string; name:string; description:string|null; is_restricted:boolean; is_active:boolean; camera_count:number };
type CameraItem = {
  id:string; site_id:string; zone_id:string|null; site_code:string; site_name:string;
  zone_code:string|null; zone_name:string|null; code:string; name:string;
  snapshot_url:string|null; status:DeviceStatus; manufacturer:string|null; model:string|null;
  ip_address:string|null; latitude:number|null; longitude:number|null; fps:number|null;
  resolution_width:number|null; resolution_height:number|null; installed_at:string|null;
  last_seen_at:string|null; stream_configured:boolean; is_active:boolean;
  deployment_count:number; health_status:DeviceStatus|null; latest_latency_ms:number|null;
  latest_packet_loss_pct:number|null; updated_at:string;
};
type DemoVideo = { id:number; labels:string[]; stream_url:string };
type Summary = { sites:number; zones:number; cameras:number; online:number; offline:number; warning:number; maintenance:number; disabled:number; restricted_zones:number };
type Infrastructure = { sites:Site[]; zones:Zone[]; cameras:CameraItem[]; summary:Summary };
type HealthSample = { id:number; status:DeviceStatus; latency_ms:number|null; fps:number|null; packet_loss_pct:number|null; cpu_usage_pct:number|null; gpu_usage_pct:number|null; temperature_c:number|null; sampled_at:string };
type Deployment = { id:string; model_code:string; model_name:string; version:string; confidence_threshold:number; is_enabled:boolean; deployed_at:string };
type CameraDetail = CameraItem & { health_samples:HealthSample[]; deployments:Deployment[]; events_24h:number; events_7d:number };
type Modal = { type:'site'|'zone'|'camera'; mode:'create'|'edit'; id?:string } | null;
type SiteForm = { code:string; name:string; address:string; latitude:string; longitude:string; timezone:string; is_active:boolean };
type ZoneForm = { site_id:string; code:string; name:string; description:string; is_restricted:boolean; is_active:boolean };
type CameraForm = { site_id:string; zone_id:string; code:string; name:string; snapshot_url:string; status:DeviceStatus; manufacturer:string; model:string; ip_address:string; latitude:string; longitude:string; fps:string; resolution_width:string; resolution_height:string; installed_at:string; is_active:boolean };

const EMPTY_SUMMARY: Summary = { sites:0, zones:0, cameras:0, online:0, offline:0, warning:0, maintenance:0, disabled:0, restricted_zones:0 };
const statusLabels: Record<DeviceStatus,string> = { online:'Trực tuyến', offline:'Ngoại tuyến', warning:'Cảnh báo', maintenance:'Bảo trì', disabled:'Đã tắt' };
const statusOptions = Object.keys(statusLabels) as DeviceStatus[];

function headers(): HeadersInit {
  const stored = readAuthSession();
  return { 'Content-Type':'application/json', ...(stored ? { Authorization:'Bearer ' + stored.session.access_token } : {}) };
}
function apiError(payload:unknown):string {
  return payload && typeof payload === 'object' && 'detail' in payload ? String((payload as {detail:unknown}).detail) : 'Không thể hoàn thành yêu cầu.';
}
function numberOrNull(value:string):number|null { return value.trim() === '' ? null : Number(value); }
function dateTime(value:string|null):string {
  return value ? new Intl.DateTimeFormat('vi-VN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : 'Chưa có dữ liệu';
}
function relative(value:string|null):string {
  if (!value) return 'Chưa từng kết nối';
  const seconds = Math.max(0,(Date.now()-new Date(value).getTime())/1000);
  if (seconds < 60) return 'Vừa cập nhật';
  if (seconds < 3600) return Math.floor(seconds/60)+' phút trước';
  if (seconds < 86400) return Math.floor(seconds/3600)+' giờ trước';
  return Math.floor(seconds/86400)+' ngày trước';
}
function emptySite():SiteForm { return {code:'',name:'',address:'',latitude:'',longitude:'',timezone:'Asia/Ho_Chi_Minh',is_active:true}; }
function emptyZone(site=''):ZoneForm { return {site_id:site,code:'',name:'',description:'',is_restricted:false,is_active:true}; }
function emptyCamera(site=''):CameraForm { return {site_id:site,zone_id:'',code:'',name:'',snapshot_url:'',status:'offline',manufacturer:'',model:'',ip_address:'',latitude:'',longitude:'',fps:'25',resolution_width:'1920',resolution_height:'1080',installed_at:'',is_active:true}; }

export default function CamerasManagement() {
  const [data,setData] = useState<Infrastructure>({sites:[],zones:[],cameras:[],summary:EMPTY_SUMMARY});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [search,setSearch] = useState('');
  const [status,setStatus] = useState<'all'|DeviceStatus>('all');
  const [scope,setScope] = useState('all');
  const [view,setView] = useState<'grid'|'list'>('grid');
  const [expanded,setExpanded] = useState<Set<string>>(new Set());
  const [selectedId,setSelectedId] = useState('');
  const [detail,setDetail] = useState<CameraDetail|null>(null);
  const [detailLoading,setDetailLoading] = useState(false);
  const [detailTab,setDetailTab] = useState<'overview'|'health'|'ai'>('overview');
  const [mobileDetail,setMobileDetail] = useState(false);
  const [modal,setModal] = useState<Modal>(null);
  const [siteForm,setSiteForm] = useState<SiteForm>(emptySite());
  const [zoneForm,setZoneForm] = useState<ZoneForm>(emptyZone());
  const [cameraForm,setCameraForm] = useState<CameraForm>(emptyCamera());
  const [busy,setBusy] = useState(false);
  const [toast,setToast] = useState('');
  const [demoVideos,setDemoVideos] = useState<DemoVideo[]>([]);
  const [previewUrls,setPreviewUrls] = useState<Record<string,string>>({});
  const [demoCatalogReady,setDemoCatalogReady] = useState(false);
  const permissions = useMemo(() => {
    if (typeof window === 'undefined') return new Set<string>();
    const stored=readAuthSession(); return stored ? userPermissions(stored.session.user) : new Set<string>();
  },[]);
  const canCameraManage=permissions.has('camera.manage');
  const canSiteManage=permissions.has('site.manage');

  const loadData=useCallback(async(quiet=false)=>{
    if(!quiet)setLoading(true); setError('');
    try {
      const [response,videosResponse]=await Promise.all([
        fetch(API_BASE+'/api/infrastructure',{headers:headers()}),
        fetch(API_BASE+'/api/videos/test',{headers:headers()}),
      ]);
      const payload=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(apiError(payload));
      const next=payload as Infrastructure; setData(next);
      if(videosResponse.ok)setDemoVideos(await videosResponse.json() as DemoVideo[]);
      setDemoCatalogReady(true);
      setExpanded(current=>current.size ? current : new Set(next.sites.map(site=>site.id)));
      setSelectedId(current=>next.cameras.some(camera=>camera.id===current)?current:next.cameras[0]?.id||'');
    } catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải hạ tầng camera.');}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void loadData();},[loadData]);

  useEffect(()=>{
    if(!data.cameras.length||!demoVideos.length)return;
    const controller=new AbortController(),created:string[]=[];
    const preferred:Record<string,string>={
      'CAM-01':'Safe Walkway Violation','CAM-02':'Carrying Overload with Forklift',
      'CAM-03':'Opened Panel Cover','CAM-04':'Unauthorized Intervention',
      'CAM-05':'Safe Walkway Violation','CAM-06':'Carrying Overload with Forklift',
      'CAM-07':'Safe Carrying','CAM-08':'Unauthorized Intervention',
      'CAM-09':'Authorized Intervention',
    };
    void Promise.all(data.cameras.map(async(camera,index)=>{
      if(camera.snapshot_url)return null;
      const label=preferred[camera.code];
      const video=demoVideos.find(item=>label&&item.labels.includes(label))||demoVideos[index%demoVideos.length];
      try{
        const response=await fetch(API_BASE+'/api/videos/'+video.id+'/thumbnail',{headers:headers(),signal:controller.signal});
        if(!response.ok)return null;
        const url=URL.createObjectURL(await response.blob());created.push(url);
        return [camera.id,url] as const;
      }catch{return null;}
    })).then(items=>{
      if(controller.signal.aborted)return;
      setPreviewUrls(Object.fromEntries(items.filter((item):item is readonly[string,string]=>item!==null)));
    });
    return()=>{controller.abort();created.forEach(url=>URL.revokeObjectURL(url));};
  },[data.cameras,demoVideos]);

  const loadDetail=useCallback(async(id:string)=>{
    if(!id){setDetail(null);return;} setDetailLoading(true);
    try{const response=await fetch(API_BASE+'/api/infrastructure/cameras/'+id,{headers:headers()}); const payload=await response.json().catch(()=>null); if(!response.ok)throw new Error(apiError(payload)); setDetail(payload as CameraDetail);}
    catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải chi tiết camera.');}
    finally{setDetailLoading(false);}
  },[]);
  useEffect(()=>{void loadDetail(selectedId);},[selectedId,loadDetail]);

  const filtered=useMemo(()=>data.cameras.filter(camera=>{
    const matchText=!search.trim() || [camera.code,camera.name,camera.site_name,camera.zone_name||'',camera.ip_address||''].join(' ').toLowerCase().includes(search.toLowerCase());
    const matchStatus=status==='all'||camera.status===status;
    const matchScope=scope==='all'||scope==='unassigned'&&!camera.zone_id||scope.startsWith('site:')&&camera.site_id===scope.slice(5)||scope.startsWith('zone:')&&camera.zone_id===scope.slice(5);
    return matchText&&matchStatus&&matchScope;
  }),[data.cameras,search,status,scope]);

  function selectCamera(id:string){setSelectedId(id);setDetailTab('overview');setMobileDetail(true);}
  function notify(message:string){setToast(message);window.setTimeout(()=>setToast(''),2800);}
  function openSite(site?:Site){setSiteForm(site?{code:site.code,name:site.name,address:site.address||'',latitude:site.latitude?.toString()||'',longitude:site.longitude?.toString()||'',timezone:site.timezone,is_active:site.is_active}:emptySite());setModal({type:'site',mode:site?'edit':'create',id:site?.id});}
  function openZone(zone?:Zone,siteId?:string){setZoneForm(zone?{site_id:zone.site_id,code:zone.code,name:zone.name,description:zone.description||'',is_restricted:zone.is_restricted,is_active:zone.is_active}:emptyZone(siteId||data.sites[0]?.id||''));setModal({type:'zone',mode:zone?'edit':'create',id:zone?.id});}
  function openCamera(camera?:CameraItem,siteId?:string){setCameraForm(camera?{site_id:camera.site_id,zone_id:camera.zone_id||'',code:camera.code,name:camera.name,snapshot_url:camera.snapshot_url||'',status:camera.status,manufacturer:camera.manufacturer||'',model:camera.model||'',ip_address:camera.ip_address||'',latitude:camera.latitude?.toString()||'',longitude:camera.longitude?.toString()||'',fps:camera.fps?.toString()||'',resolution_width:camera.resolution_width?.toString()||'',resolution_height:camera.resolution_height?.toString()||'',installed_at:camera.installed_at||'',is_active:camera.is_active}:emptyCamera(siteId||data.sites[0]?.id||''));setModal({type:'camera',mode:camera?'edit':'create',id:camera?.id});}

  async function submit(event:FormEvent){event.preventDefault();if(!modal)return;setBusy(true);
    try{
      let payload:Record<string,unknown>; let base:string;
      if(modal.type==='site'){payload={...siteForm,latitude:numberOrNull(siteForm.latitude),longitude:numberOrNull(siteForm.longitude),address:siteForm.address||null};base='/sites';}
      else if(modal.type==='zone'){payload={...zoneForm,description:zoneForm.description||null};base='/zones';}
      else {payload={...cameraForm,zone_id:cameraForm.zone_id||null,snapshot_url:cameraForm.snapshot_url||null,manufacturer:cameraForm.manufacturer||null,model:cameraForm.model||null,ip_address:cameraForm.ip_address||null,latitude:numberOrNull(cameraForm.latitude),longitude:numberOrNull(cameraForm.longitude),fps:numberOrNull(cameraForm.fps),resolution_width:numberOrNull(cameraForm.resolution_width),resolution_height:numberOrNull(cameraForm.resolution_height),installed_at:cameraForm.installed_at||null};base='/cameras';}
      const path='/api/infrastructure'+base+(modal.mode==='edit'?'/'+modal.id+'/update':'');
      const response=await fetch(API_BASE+path,{method:'POST',headers:headers(),body:JSON.stringify(payload)});const result=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(result));
      setModal(null);notify((result as {message?:string})?.message||'Đã lưu thay đổi');await loadData(true);if(selectedId)await loadDetail(selectedId);
    }catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể lưu dữ liệu.');}finally{setBusy(false);}
  }
  async function changeStatus(next:DeviceStatus){if(!detail)return;setBusy(true);try{const response=await fetch(API_BASE+'/api/infrastructure/cameras/'+detail.id+'/status',{method:'POST',headers:headers(),body:JSON.stringify({status:next})});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));notify('Đã đổi trạng thái camera');await loadData(true);await loadDetail(detail.id);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể đổi trạng thái.');}finally{setBusy(false);}}

  const currentSite=scope.startsWith('site:')?data.sites.find(item=>item.id===scope.slice(5)):null;
  const scopeTitle=scope==='all'?'Tất cả camera':scope==='unassigned'?'Chưa gán khu vực':currentSite?.name||data.zones.find(item=>item.id===scope.slice(5))?.name||'Camera';
  const modalZones=data.zones.filter(zone=>zone.site_id===cameraForm.site_id);

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>HẠ TẦNG GIÁM SÁT</span><h1>Camera & khu vực</h1><p>Quản lý tập trung cấu trúc nhà máy, vùng quan sát và sức khỏe toàn bộ thiết bị.</p></div>
      <div className={styles.headerActions}>
        <button className={styles.secondaryButton} onClick={()=>void loadData()} disabled={loading}><RefreshCw size={16} className={loading?styles.spin:''}/> Đồng bộ</button>
        {canCameraManage&&<button className={styles.primaryButton} onClick={()=>openCamera()} disabled={!data.sites.length}><Plus size={17}/> Thêm camera</button>}
      </div>
    </header>

    {error&&<div className={styles.errorBanner}><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')}><X size={15}/></button></div>}
    <section className={styles.metrics}>
      <article><span data-tone="blue"><Video size={19}/></span><div><small>Tổng camera</small><strong>{data.summary.cameras}</strong><em>{data.summary.sites} nhà máy · {data.summary.zones} khu vực</em></div></article>
      <article><span data-tone="green"><Signal size={19}/></span><div><small>Đang trực tuyến</small><strong>{data.summary.online}</strong><em>{data.summary.cameras?Math.round(data.summary.online/data.summary.cameras*100):0}% hệ thống</em></div></article>
      <article><span data-tone="red"><WifiOff size={19}/></span><div><small>Ngoại tuyến</small><strong>{data.summary.offline}</strong><em>Cần kiểm tra kết nối</em></div></article>
      <article><span data-tone="amber"><AlertTriangle size={19}/></span><div><small>Cần chú ý</small><strong>{data.summary.warning+data.summary.maintenance}</strong><em>{data.summary.warning} cảnh báo · {data.summary.maintenance} bảo trì</em></div></article>
      <article><span data-tone="violet"><LockKeyhole size={19}/></span><div><small>Vùng hạn chế</small><strong>{data.summary.restricted_zones}</strong><em>Đang áp dụng kiểm soát</em></div></article>
    </section>

    <section className={styles.workspace}>
      <aside className={styles.treePanel}>
        <div className={styles.panelTitle}><div><strong>Cấu trúc hệ thống</strong><span>Nhà máy và khu vực</span></div>{canSiteManage&&<button title="Thêm nhà máy" onClick={()=>openSite()}><Plus size={17}/></button>}</div>
        <button className={`${styles.treeRoot} ${scope==='all'?styles.activeTree:''}`} onClick={()=>setScope('all')}><span><Server size={16}/> Tất cả camera</span><b>{data.summary.cameras}</b></button>
        <div className={styles.treeScroll}>
          {data.sites.map(site=>{const isOpen=expanded.has(site.id);const zones=data.zones.filter(zone=>zone.site_id===site.id);return <div className={styles.siteNode} key={site.id}>
            <div className={`${styles.treeRow} ${scope==='site:'+site.id?styles.activeTree:''}`}>
              <button className={styles.chevron} onClick={()=>setExpanded(current=>{const next=new Set(current);next.has(site.id)?next.delete(site.id):next.add(site.id);return next;})}>{isOpen?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button>
              <button className={styles.treeLabel} onClick={()=>setScope('site:'+site.id)}><Building2 size={16}/><span><strong>{site.name}</strong><small>{site.code}</small></span><b>{site.camera_count}</b></button>
              {canSiteManage&&<button className={styles.rowAction} title="Sửa nhà máy" onClick={()=>openSite(site)}><Edit3 size={13}/></button>}
            </div>
            {isOpen&&<div className={styles.zoneBranch}>{zones.map(zone=><div className={`${styles.zoneRow} ${scope==='zone:'+zone.id?styles.activeTree:''}`} key={zone.id}>
              <button onClick={()=>setScope('zone:'+zone.id)}><MapPin size={14}/><span>{zone.name}{zone.is_restricted&&<LockKeyhole size={11}/>}</span><b>{zone.camera_count}</b></button>
              {canSiteManage&&<button className={styles.rowAction} title="Sửa khu vực" onClick={()=>openZone(zone)}><Edit3 size={12}/></button>}
            </div>)}
            {canSiteManage&&<button className={styles.addNested} onClick={()=>openZone(undefined,site.id)}><Plus size={13}/> Thêm khu vực</button>}</div>}
          </div>})}
          {!!data.cameras.filter(camera=>!camera.zone_id).length&&<button className={`${styles.unassigned} ${scope==='unassigned'?styles.activeTree:''}`} onClick={()=>setScope('unassigned')}><MoreHorizontal size={15}/> Chưa gán khu vực <b>{data.cameras.filter(camera=>!camera.zone_id).length}</b></button>}
        </div>
      </aside>

      <main className={styles.contentPanel}>
        <div className={styles.contentHeader}><div><span>Đang xem</span><h2>{scopeTitle}</h2><small>{filtered.length} camera phù hợp</small></div><div className={styles.viewSwitch}><button className={view==='grid'?styles.selected:''} onClick={()=>setView('grid')} title="Dạng lưới"><Grid2X2 size={16}/></button><button className={view==='list'?styles.selected:''} onClick={()=>setView('list')} title="Dạng bảng"><LayoutList size={17}/></button></div></div>
        <div className={styles.toolbar}>
          <label className={styles.search}><Search size={16}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Tìm tên, mã, IP, khu vực..."/>{search&&<button onClick={()=>setSearch('')}><X size={14}/></button>}</label>
          <label className={styles.filter}><Filter size={15}/><select value={status} onChange={event=>setStatus(event.target.value as 'all'|DeviceStatus)}><option value="all">Mọi trạng thái</option>{statusOptions.map(item=><option value={item} key={item}>{statusLabels[item]}</option>)}</select></label>
          {canCameraManage&&<button className={styles.compactAdd} onClick={()=>openCamera(undefined,currentSite?.id)} disabled={!data.sites.length}><Plus size={15}/> Camera</button>}
        </div>

        {loading?<div className={styles.loading}><LoaderCircle className={styles.spin}/><strong>Đang tải hạ tầng camera</strong><span>Đồng bộ dữ liệu từ PostgreSQL...</span></div>:
        !data.sites.length?<div className={styles.empty}><span><Building2 size={28}/></span><h3>Chưa có nhà máy nào</h3><p>Tạo nhà máy đầu tiên, sau đó thêm khu vực và camera để bắt đầu quản lý hạ tầng.</p>{canSiteManage&&<button className={styles.primaryButton} onClick={()=>openSite()}><Plus size={16}/> Tạo nhà máy đầu tiên</button>}</div>:
        !filtered.length?<div className={styles.empty}><span><Search size={27}/></span><h3>Không tìm thấy camera</h3><p>Hãy thay đổi từ khóa, trạng thái hoặc phạm vi đang chọn.</p><button className={styles.secondaryButton} onClick={()=>{setSearch('');setStatus('all');setScope('all');}}>Xóa bộ lọc</button></div>:
        view==='grid'?<div className={styles.cameraGrid}>{filtered.map(camera=><button className={`${styles.cameraCard} ${selectedId===camera.id?styles.activeCard:''}`} key={camera.id} onClick={()=>selectCamera(camera.id)}>
          <div className={styles.preview}>{camera.snapshot_url||previewUrls[camera.id]?<img src={camera.snapshot_url||previewUrls[camera.id]} alt={'Ảnh xem trước '+camera.name} onError={event=>{const fallback=previewUrls[camera.id];if(fallback&&event.currentTarget.src!==fallback)event.currentTarget.src=fallback;else event.currentTarget.style.visibility='hidden';}}/>:<div className={styles.previewFallback}>{demoCatalogReady?<Camera size={31}/>:<LoaderCircle className={styles.spin} size={31}/>}<span>{demoCatalogReady?'Chưa cấu hình ảnh xem trước':'Đang tải ảnh xem trước...'}</span></div>}<span className={styles.statusBadge} data-status={camera.status}><i/>{statusLabels[camera.status]}</span><span className={styles.codeBadge}>{camera.code}</span>{!camera.snapshot_url&&previewUrls[camera.id]&&<span className={styles.demoBadge}>Dữ liệu kiểm thử</span>}</div>
          <div className={styles.cardBody}><div><strong>{camera.name}</strong><span><MapPin size={13}/>{camera.zone_name||'Chưa gán khu vực'} · {camera.site_name}</span></div><ChevronRight size={16}/></div>
          <div className={styles.cardMeta}><span><Network size={13}/>{camera.ip_address||'Chưa có IP'}</span><span><Zap size={13}/>{camera.latest_latency_ms!==null?camera.latest_latency_ms+' ms':'—'}</span><span><Cpu size={13}/>{camera.deployment_count} AI</span></div>
        </button>)}</div>:
        <div className={styles.tableWrap}><table><thead><tr><th>Camera</th><th>Vị trí</th><th>Trạng thái</th><th>Kết nối</th><th>Thông số</th><th>Cập nhật</th><th/></tr></thead><tbody>{filtered.map(camera=><tr key={camera.id} className={selectedId===camera.id?styles.activeRow:''} onClick={()=>selectCamera(camera.id)}><td><div className={styles.cameraCell}><span><Camera size={17}/></span><div><strong>{camera.name}</strong><small>{camera.code}</small></div></div></td><td><strong>{camera.zone_name||'Chưa gán'}</strong><small>{camera.site_name}</small></td><td><span className={styles.inlineStatus} data-status={camera.status}><i/>{statusLabels[camera.status]}</span></td><td><strong>{camera.ip_address||'—'}</strong><small>{camera.stream_configured?'Đã cấu hình luồng':'Chưa có luồng'}</small></td><td><strong>{camera.resolution_width&&camera.resolution_height?camera.resolution_width+'×'+camera.resolution_height:'—'}</strong><small>{camera.fps?camera.fps+' FPS':'Chưa cấu hình'}</small></td><td><strong>{relative(camera.last_seen_at)}</strong><small>{camera.latest_latency_ms!==null?camera.latest_latency_ms+' ms':'Chưa có health check'}</small></td><td><ChevronRight size={16}/></td></tr>)}</tbody></table></div>}
      </main>

      <aside className={`${styles.detailPanel} ${mobileDetail?styles.mobileOpen:''}`}>
        <div className={styles.detailTop}><div><span>CHI TIẾT THIẾT BỊ</span><button onClick={()=>setMobileDetail(false)}><X size={17}/></button></div>{detail&&<><h2>{detail.name}</h2><p>{detail.code} · {detail.site_name}</p></>}</div>
        {detailLoading?<div className={styles.detailLoading}><LoaderCircle className={styles.spin}/></div>:detail?<>
          <div className={styles.detailHero}><span data-status={detail.status}><Radio size={22}/></span><div><strong>{statusLabels[detail.status]}</strong><small>{relative(detail.last_seen_at)}</small></div>{canCameraManage&&<button onClick={()=>openCamera(detail)}><Edit3 size={15}/> Sửa</button>}</div>
          <div className={styles.detailTabs}><button className={detailTab==='overview'?styles.selectedTab:''} onClick={()=>setDetailTab('overview')}>Tổng quan</button><button className={detailTab==='health'?styles.selectedTab:''} onClick={()=>setDetailTab('health')}>Sức khỏe</button><button className={detailTab==='ai'?styles.selectedTab:''} onClick={()=>setDetailTab('ai')}>Mô hình AI</button></div>
          <div className={styles.detailScroll}>
            {detailTab==='overview'&&<Overview detail={detail}/>}
            {detailTab==='health'&&<Health detail={detail}/>}
            {detailTab==='ai'&&<AI detail={detail}/>}
          </div>
          {canCameraManage&&<div className={styles.statusControl}><label>Trạng thái vận hành<select value={detail.status} disabled={busy} onChange={event=>void changeStatus(event.target.value as DeviceStatus)}>{statusOptions.map(item=><option key={item} value={item}>{statusLabels[item]}</option>)}</select></label></div>}
        </>:<div className={styles.emptyDetail}><Camera size={28}/><p>Chọn một camera để xem thông tin.</p></div>}
      </aside>
    </section>

    {modal&&<EditorModal modal={modal} sites={data.sites} zones={modalZones} siteForm={siteForm} zoneForm={zoneForm} cameraForm={cameraForm} busy={busy} setSiteForm={setSiteForm} setZoneForm={setZoneForm} setCameraForm={setCameraForm} close={()=>setModal(null)} submit={submit}/>}
    {toast&&<div className={styles.toast}><CheckCircle2 size={17}/>{toast}</div>}
  </div>;
}

function Overview({detail}:{detail:CameraDetail}) {
  return <>
    <section className={styles.detailSection}><h3>Vị trí & kết nối</h3><div className={styles.infoGrid}>
      <Info icon={<MapPin/>} label="Khu vực" value={detail.zone_name||'Chưa gán khu vực'}/>
      <Info icon={<Building2/>} label="Nhà máy" value={detail.site_name}/>
      <Info icon={<Network/>} label="Địa chỉ IP" value={detail.ip_address||'Chưa cấu hình'}/>
      <Info icon={<Video/>} label="Luồng video" value={detail.stream_configured?'Đã cấu hình an toàn':'Chưa cấu hình'}/>
    </div></section>
    <section className={styles.detailSection}><h3>Thông số hình ảnh</h3><div className={styles.specList}>
      <div><span>Độ phân giải</span><strong>{detail.resolution_width&&detail.resolution_height?detail.resolution_width+' × '+detail.resolution_height:'Chưa thiết lập'}</strong></div>
      <div><span>Tốc độ khung hình</span><strong>{detail.fps?detail.fps+' FPS':'Chưa thiết lập'}</strong></div>
      <div><span>Hãng / model</span><strong>{[detail.manufacturer,detail.model].filter(Boolean).join(' · ')||'Chưa cập nhật'}</strong></div>
      <div><span>Ngày lắp đặt</span><strong>{detail.installed_at?new Intl.DateTimeFormat('vi-VN').format(new Date(detail.installed_at)):'Chưa cập nhật'}</strong></div>
    </div></section>
    <section className={styles.quickStats}><div><Activity size={16}/><span>Sự kiện 24 giờ</span><strong>{detail.events_24h}</strong></div><div><ShieldCheck size={16}/><span>Sự kiện 7 ngày</span><strong>{detail.events_7d}</strong></div><div><Cpu size={16}/><span>AI đang chạy</span><strong>{detail.deployment_count}</strong></div></section>
    <section className={styles.securityNote}><LockKeyhole size={17}/><div><strong>Credential luồng được bảo vệ</strong><p>Dashboard không tải hoặc hiển thị URL RTSP bí mật. Chỉ trạng thái cấu hình được trả về trình duyệt.</p></div></section>
  </>;
}
function Info({icon,label,value}:{icon:React.ReactNode;label:string;value:string}) { return <div className={styles.infoItem}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }

function Health({detail}:{detail:CameraDetail}) {
  const latest=detail.health_samples[0];
  const bars=detail.health_samples.slice(0,18).reverse();
  return <>
    <section className={styles.healthGrid}>
      <div><span><Gauge size={16}/> Độ trễ</span><strong>{latest?.latency_ms!==null&&latest?.latency_ms!==undefined?latest.latency_ms+' ms':'—'}</strong></div>
      <div><span><Activity size={16}/> FPS thực tế</span><strong>{latest?.fps??'—'}</strong></div>
      <div><span><Signal size={16}/> Mất gói</span><strong>{latest?.packet_loss_pct!==null&&latest?.packet_loss_pct!==undefined?latest.packet_loss_pct+'%':'—'}</strong></div>
      <div><span><Thermometer size={16}/> Nhiệt độ</span><strong>{latest?.temperature_c!==null&&latest?.temperature_c!==undefined?latest.temperature_c+'°C':'—'}</strong></div>
    </section>
    <section className={styles.detailSection}><h3>Độ trễ gần đây</h3>{bars.length?<div className={styles.barChart}>{bars.map(sample=><div key={sample.id} title={dateTime(sample.sampled_at)+' · '+(sample.latency_ms??0)+' ms'}><i style={{height:Math.min(100,Math.max(8,(sample.latency_ms||0)/5))+'%'}} data-status={sample.status}/></div>)}</div>:<div className={styles.miniEmpty}><Activity size={22}/><p>Chưa có mẫu sức khỏe. Agent camera sẽ ghi dữ liệu vào <code>camera_health_samples</code>.</p></div>}</section>
    <section className={styles.detailSection}><h3>Lịch sử kiểm tra</h3>{detail.health_samples.length?<div className={styles.healthHistory}>{detail.health_samples.slice(0,6).map(sample=><div key={sample.id}><span data-status={sample.status}><CircleDot size={14}/></span><div><strong>{statusLabels[sample.status]}</strong><small>{dateTime(sample.sampled_at)}</small></div><b>{sample.latency_ms!==null?sample.latency_ms+' ms':'—'}</b></div>)}</div>:<p className={styles.muted}>Chưa ghi nhận dữ liệu.</p>}</section>
  </>;
}
function AI({detail}:{detail:CameraDetail}) {
  return <><section className={styles.aiSummary}><span><Cpu size={22}/></span><div><strong>{detail.deployments.filter(item=>item.is_enabled).length} mô hình đang hoạt động</strong><p>Cấu hình nhận diện đang được triển khai trên camera này.</p></div></section>
    <section className={styles.detailSection}><h3>Danh sách triển khai</h3>{detail.deployments.length?<div className={styles.deployments}>{detail.deployments.map(item=><article key={item.id}><div><span><Cpu size={16}/></span><div><strong>{item.model_name}</strong><small>{item.model_code} · v{item.version}</small></div></div><span className={item.is_enabled?styles.enabled:styles.paused}>{item.is_enabled?'Đang chạy':'Tạm dừng'}</span><footer><span>Ngưỡng tin cậy</span><strong>{Math.round(item.confidence_threshold*100)}%</strong></footer></article>)}</div>:<div className={styles.miniEmpty}><Cpu size={24}/><p>Camera chưa được gán mô hình AI nào.</p></div>}</section>
  </>;
}

type EditorProps={modal:Exclude<Modal,null>;sites:Site[];zones:Zone[];siteForm:SiteForm;zoneForm:ZoneForm;cameraForm:CameraForm;busy:boolean;setSiteForm:Dispatch<SetStateAction<SiteForm>>;setZoneForm:Dispatch<SetStateAction<ZoneForm>>;setCameraForm:Dispatch<SetStateAction<CameraForm>>;close:()=>void;submit:(event:FormEvent)=>void};
function EditorModal(props:EditorProps) {
  const {modal,sites,zones,siteForm,zoneForm,cameraForm,busy,setSiteForm,setZoneForm,setCameraForm,close,submit}=props;
  const title=(modal.mode==='create'?'Thêm ':'Chỉnh sửa ')+(modal.type==='site'?'nhà máy':modal.type==='zone'?'khu vực':'camera');
  return <div className={styles.modalBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget)close();}}><form className={styles.modal} onSubmit={submit}>
    <header><div><span>{modal.type==='camera'?<Camera size={18}/>:modal.type==='zone'?<MapPin size={18}/>:<Building2 size={18}/>}</span><div><small>CẤU HÌNH HẠ TẦNG</small><h2>{title}</h2></div></div><button type="button" onClick={close}><X size={18}/></button></header>
    <div className={styles.formBody}>
      {modal.type==='site'&&<>
        <div className={styles.formGrid}><Field label="Mã nhà máy *"><input required pattern="[A-Za-z0-9_-]+" value={siteForm.code} onChange={e=>setSiteForm(v=>({...v,code:e.target.value.toUpperCase()}))} placeholder="FACTORY_HN"/></Field><Field label="Tên nhà máy *"><input required minLength={2} value={siteForm.name} onChange={e=>setSiteForm(v=>({...v,name:e.target.value}))} placeholder="Nhà máy Hà Nội"/></Field></div>
        <Field label="Địa chỉ"><input value={siteForm.address} onChange={e=>setSiteForm(v=>({...v,address:e.target.value}))} placeholder="Địa chỉ đầy đủ"/></Field>
        <div className={styles.formGrid}><Field label="Vĩ độ"><input type="number" min="-90" max="90" step="any" value={siteForm.latitude} onChange={e=>setSiteForm(v=>({...v,latitude:e.target.value}))} placeholder="21.0285"/></Field><Field label="Kinh độ"><input type="number" min="-180" max="180" step="any" value={siteForm.longitude} onChange={e=>setSiteForm(v=>({...v,longitude:e.target.value}))} placeholder="105.8542"/></Field></div>
        <Field label="Múi giờ"><select value={siteForm.timezone} onChange={e=>setSiteForm(v=>({...v,timezone:e.target.value}))}><option>Asia/Ho_Chi_Minh</option><option>Asia/Bangkok</option><option>Asia/Singapore</option></select></Field>
        <Switch checked={siteForm.is_active} change={value=>setSiteForm(v=>({...v,is_active:value}))} title="Nhà máy đang hoạt động" text="Cho phép sử dụng nhà máy này trong các module vận hành."/>
      </>}
      {modal.type==='zone'&&<>
        <Field label="Nhà máy *"><select required value={zoneForm.site_id} onChange={e=>setZoneForm(v=>({...v,site_id:e.target.value}))}><option value="">Chọn nhà máy</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name} ({site.code})</option>)}</select></Field>
        <div className={styles.formGrid}><Field label="Mã khu vực *"><input required pattern="[A-Za-z0-9_-]+" value={zoneForm.code} onChange={e=>setZoneForm(v=>({...v,code:e.target.value.toUpperCase()}))} placeholder="WAREHOUSE_A"/></Field><Field label="Tên khu vực *"><input required minLength={2} value={zoneForm.name} onChange={e=>setZoneForm(v=>({...v,name:e.target.value}))} placeholder="Kho nguyên liệu A"/></Field></div>
        <Field label="Mô tả"><textarea rows={3} value={zoneForm.description} onChange={e=>setZoneForm(v=>({...v,description:e.target.value}))} placeholder="Phạm vi và lưu ý vận hành..."/></Field>
        <div className={styles.switchStack}><Switch checked={zoneForm.is_restricted} change={value=>setZoneForm(v=>({...v,is_restricted:value}))} title="Khu vực hạn chế" text="Đánh dấu vùng cần kiểm soát truy cập nghiêm ngặt."/><Switch checked={zoneForm.is_active} change={value=>setZoneForm(v=>({...v,is_active:value}))} title="Khu vực đang hoạt động" text="Hiển thị trong bộ lọc và màn hình giám sát."/></div>
      </>}
      {modal.type==='camera'&&<>
        <section className={styles.formSection}><h3>Thông tin cơ bản</h3><div className={styles.formGrid}><Field label="Mã camera *"><input required pattern="[A-Za-z0-9_-]+" value={cameraForm.code} onChange={e=>setCameraForm(v=>({...v,code:e.target.value.toUpperCase()}))} placeholder="CAM_GATE_01"/></Field><Field label="Tên camera *"><input required minLength={2} value={cameraForm.name} onChange={e=>setCameraForm(v=>({...v,name:e.target.value}))} placeholder="Camera cổng chính"/></Field></div>
        <div className={styles.formGrid}><Field label="Nhà máy *"><select required value={cameraForm.site_id} onChange={e=>setCameraForm(v=>({...v,site_id:e.target.value,zone_id:''}))}><option value="">Chọn nhà máy</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></Field><Field label="Khu vực"><select value={cameraForm.zone_id} onChange={e=>setCameraForm(v=>({...v,zone_id:e.target.value}))}><option value="">Chưa gán khu vực</option>{zones.map(zone=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></Field></div></section>
        <section className={styles.formSection}><h3>Kết nối & thiết bị</h3><div className={styles.formGrid}><Field label="Địa chỉ IP"><input value={cameraForm.ip_address} onChange={e=>setCameraForm(v=>({...v,ip_address:e.target.value}))} placeholder="192.168.1.120"/></Field><Field label="Trạng thái"><select value={cameraForm.status} onChange={e=>setCameraForm(v=>({...v,status:e.target.value as DeviceStatus}))}>{statusOptions.map(item=><option key={item} value={item}>{statusLabels[item]}</option>)}</select></Field></div>
        <Field label="URL ảnh xem trước"><input type="url" value={cameraForm.snapshot_url} onChange={e=>setCameraForm(v=>({...v,snapshot_url:e.target.value}))} placeholder="https://.../snapshot.jpg"/></Field>
        <div className={styles.secretNotice}><LockKeyhole size={16}/><p>URL RTSP có credential không được nhập tại đây. Backend chỉ trả về cờ trạng thái, không bao giờ gửi secret về trình duyệt.</p></div>
        <div className={styles.formGrid}><Field label="Hãng sản xuất"><input value={cameraForm.manufacturer} onChange={e=>setCameraForm(v=>({...v,manufacturer:e.target.value}))} placeholder="Hikvision"/></Field><Field label="Model"><input value={cameraForm.model} onChange={e=>setCameraForm(v=>({...v,model:e.target.value}))} placeholder="DS-2CD..."/></Field></div></section>
        <section className={styles.formSection}><h3>Thông số hình ảnh</h3><div className={styles.formGrid3}><Field label="Chiều rộng"><input type="number" min="1" value={cameraForm.resolution_width} onChange={e=>setCameraForm(v=>({...v,resolution_width:e.target.value}))}/></Field><Field label="Chiều cao"><input type="number" min="1" value={cameraForm.resolution_height} onChange={e=>setCameraForm(v=>({...v,resolution_height:e.target.value}))}/></Field><Field label="FPS"><input type="number" min="0.1" max="240" step="0.1" value={cameraForm.fps} onChange={e=>setCameraForm(v=>({...v,fps:e.target.value}))}/></Field></div>
        <div className={styles.formGrid}><Field label="Ngày lắp đặt"><input type="date" value={cameraForm.installed_at} onChange={e=>setCameraForm(v=>({...v,installed_at:e.target.value}))}/></Field><Field label="Tọa độ"><div className={styles.inlineInputs}><input type="number" min="-90" max="90" step="any" value={cameraForm.latitude} onChange={e=>setCameraForm(v=>({...v,latitude:e.target.value}))} placeholder="Vĩ độ"/><input type="number" min="-180" max="180" step="any" value={cameraForm.longitude} onChange={e=>setCameraForm(v=>({...v,longitude:e.target.value}))} placeholder="Kinh độ"/></div></Field></div></section>
        <Switch checked={cameraForm.is_active} change={value=>setCameraForm(v=>({...v,is_active:value}))} title="Camera được kích hoạt" text="Cho phép thiết bị xuất hiện trong luồng vận hành."/>
      </>}
    </div>
    <footer><button type="button" className={styles.cancelButton} onClick={close}>Hủy</button><button type="submit" className={styles.primaryButton} disabled={busy}>{busy?<LoaderCircle size={16} className={styles.spin}/>:<CheckCircle2 size={16}/>} {modal.mode==='create'?'Tạo mới':'Lưu thay đổi'}</button></footer>
  </form></div>;
}
function Field({label,children}:{label:string;children:React.ReactNode}) {return <label className={styles.field}><span>{label}</span>{children}</label>;}
function Switch({checked,change,title,text}:{checked:boolean;change:(value:boolean)=>void;title:string;text:string}) {return <label className={styles.switchRow}><button type="button" role="switch" aria-checked={checked} data-on={checked} onClick={()=>change(!checked)}><i/></button><span><strong>{title}</strong><small>{text}</small></span></label>;}

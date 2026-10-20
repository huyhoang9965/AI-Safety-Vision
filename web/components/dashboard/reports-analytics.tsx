'use client';

import { authenticatedFetch } from '@/lib/auth';

import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3,
  CalendarDays, Camera, ChevronDown, Clock3, Download,
  Factory, FileWarning, Gauge, LoaderCircle, MapPin, RefreshCw, ShieldCheck,
  Siren, Target, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { readAuthSession } from '@/lib/auth';
import ReportTrendChart, { type ReportTrend } from './report-trend-chart';
import styles from './reports-analytics.module.css';

const API_BASE=(process.env.NEXT_PUBLIC_API_URL||'http://localhost:8000').replace(/\/$/,'');
type Period='7d'|'30d'|'90d'|'365d';
type NamedMetric={key:string;label:string;total:number;percentage:number};
type ResponseMetrics={pending_events:number;acknowledged_events:number;overdue_events:number;acknowledge_samples:number;resolution_samples:number;acknowledged_within_24h:number;acknowledge_p50_seconds:number|null;acknowledge_p95_seconds:number|null;acknowledge_p99_seconds:number|null;resolution_p50_seconds:number|null;resolution_p95_seconds:number|null;resolution_p99_seconds:number|null};
type EventType={code:string;name:string;color:string|null;total:number;previous_total:number;change_percent:number|null;average_confidence:number|null};
type Site={code:string;name:string;total:number;critical:number;open_events:number;resolved:number;resolution_rate:number;cameras:number};
type RiskCamera={code:string;name:string;site_name:string;zone_name:string|null;status:string;total:number;critical:number;average_confidence:number|null};
type HeatCell={weekday:number;hour:number;total:number};
type RecentEvent={id:string;title:string;event_code:string;event_name:string;severity:'low'|'medium'|'high'|'critical';status:'new'|'acknowledged'|'resolved'|'dismissed';confidence:number|null;detected_at:string;site_name:string;zone_name:string|null;camera_code:string;camera_name:string;snapshot_url:string|null};
type ReportData={
 period:{days:number;start_at:string;end_at:string;previous_start_at:string};
 summary:{total_events:number;previous_events:number;event_change_percent:number|null;critical_events:number;critical_change_percent:number|null;open_events:number;resolved_events:number;resolution_rate:number;average_acknowledge_seconds:number|null;average_resolution_seconds:number|null;average_confidence:number|null;incidents:number;overdue_incidents:number;reporting_cameras:number};
 trend:ReportTrend[];response_metrics?:ResponseMetrics|null;event_types:EventType[];severities:NamedMetric[];statuses:NamedMetric[];
 sites:Site[];cameras:RiskCamera[];heatmap:HeatCell[];recent_events:RecentEvent[];
 filters:{sites:Array<{code:string;name:string}>};generated_at:string;
};

const PERIODS:Array<{value:Period;label:string}>=[
 {value:'7d',label:'7 ngày'},{value:'30d',label:'30 ngày'},
 {value:'90d',label:'90 ngày'},{value:'365d',label:'12 tháng'},
];
const severityLabel={critical:'Nghiêm trọng',high:'Cao',medium:'Trung bình',low:'Thấp'};
const statusLabel={new:'Mới',acknowledged:'Đã xác nhận',resolved:'Đã xử lý',dismissed:'Bỏ qua'};
const cameraStatusLabel:Record<string,string>={online:'Trực tuyến',offline:'Ngoại tuyến',warning:'Cảnh báo',maintenance:'Bảo trì',disabled:'Đã tắt'};

function headers():HeadersInit{const stored=readAuthSession();return stored?{Authorization:'Bearer '+stored.session.access_token}:{};}
function apiError(payload:unknown){return payload&&typeof payload==='object'&&'detail' in payload?String((payload as {detail:unknown}).detail):'Không thể tải dữ liệu báo cáo.';}
function number(value:number){return new Intl.NumberFormat('vi-VN').format(value);}
function percent(value:number|null){return value===null?'—':Math.round(value*100)+'%';}
function duration(value:number|null){if(value===null)return'—';if(value<60)return Math.round(value)+' giây';if(value<3600)return Math.round(value/60)+' phút';return(value/3600).toFixed(1)+' giờ';}
function fullTime(value:string){return new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));}

function Delta({value,inverse=false}:{value:number|null;inverse?:boolean}){
 if(value===null)return <span className={styles.neutral}>Chưa có kỳ trước</span>;
 const positive=value>0,good=inverse?!positive:positive;
 return <span className={good?styles.good:positive?styles.bad:styles.neutral}>{positive?<ArrowUpRight/>:<ArrowDownRight/>}{Math.abs(value).toFixed(1)}% so với kỳ trước</span>;
}
function Kpi({icon,label,value,detail,tone='green',delta,inverse}:{icon:ReactNode;label:string;value:string;detail:string;tone?:string;delta?:number|null;inverse?:boolean}){
 return <article className={styles.kpi} data-tone={tone}><div className={styles.kpiTop}><span>{icon}</span><small>{label}</small></div><strong>{value}</strong><p>{detail}</p>{delta!==undefined&&<Delta value={delta} inverse={inverse}/>}</article>;
}

export default function ReportsAnalytics(){
 const[data,setData]=useState<ReportData|null>(null),[period,setPeriod]=useState<Period>('30d'),[site,setSite]=useState(''),[loading,setLoading]=useState(true),[exporting,setExporting]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null);
 const load=useCallback(async()=>{request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');const query=new URLSearchParams({period});if(site)query.set('site',site);try{const response=await authenticatedFetch(API_BASE+'/api/reports/overview?'+query,{headers:headers(),signal:controller.signal});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));if(!controller.signal.aborted)setData(payload as ReportData);}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Không thể tải báo cáo.');}finally{if(!controller.signal.aborted)setLoading(false);}},[period,site]);
 useEffect(()=>{void load();return()=>request.current?.abort();},[load]);
 async function exportReport(){setExporting(true);setError('');const query=new URLSearchParams({period});if(site)query.set('site',site);try{const response=await authenticatedFetch(API_BASE+'/api/reports/export?'+query,{headers:headers()});if(!response.ok)throw new Error(apiError(await response.json().catch(()=>null)));const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='bao-cao-an-toan-'+period+'.csv';link.click();URL.revokeObjectURL(url);}catch(reason){setError(reason instanceof Error?reason.message:'Không thể xuất báo cáo.');}finally{setExporting(false);}}
 if(!data&&loading)return <div className={styles.loading}><LoaderCircle/><strong>Đang tổng hợp dữ liệu an toàn</strong><span>Phân tích sự kiện, sự cố và hiệu suất xử lý...</span></div>;
 if(!data)return <div className={styles.loading}><AlertTriangle/><strong>Không thể mở báo cáo</strong><span>{error}</span><button onClick={()=>void load()}><RefreshCw/>Thử lại</button></div>;
 const s=data.summary;
 return <div className={styles.page}>
  <header className={styles.heading}><div><span className={styles.eyebrow}><BarChart3/> SAFETY INTELLIGENCE</span><h1>Báo cáo & thống kê</h1><p>Đo lường xu hướng rủi ro, hiệu quả phản ứng và các điểm nóng cần ưu tiên.</p></div><div className={styles.actions}><label><MapPin/><select value={site} onChange={e=>setSite(e.target.value)}><option value="">Tất cả cơ sở</option>{data.filters.sites.map(x=><option key={x.code} value={x.code}>{x.name}</option>)}</select><ChevronDown/></label><button onClick={()=>void load()} disabled={loading} title="Làm mới"><RefreshCw className={loading?styles.spin:''}/></button><button className={styles.export} onClick={()=>void exportReport()} disabled={exporting}>{exporting?<LoaderCircle className={styles.spin}/>:<Download/>}Xuất CSV</button></div></header>
  <section className={styles.periodBar}><div className={styles.periods}>{PERIODS.map(item=><button key={item.value} className={period===item.value?styles.activePeriod:''} onClick={()=>setPeriod(item.value)}>{item.label}</button>)}</div><span><CalendarDays/> {fullTime(data.period.start_at)} — {fullTime(data.period.end_at)}</span><em><i/>Dữ liệu cập nhật {fullTime(data.generated_at)}</em></section>
  {error&&<div className={styles.error}><AlertTriangle/><span>{error}</span><button onClick={()=>setError('')}><X/></button></div>}
  {loading&&<p className={styles.updating} role="status">Đang cập nhật theo bộ lọc đã chọn…</p>}
  <section className={styles.kpis}>
   <Kpi icon={<Siren/>} label="Tổng cảnh báo" value={number(s.total_events)} detail={number(s.open_events)+' cảnh báo đang mở'} delta={s.event_change_percent} inverse tone="red"/>
   <Kpi icon={<AlertTriangle/>} label="Mức nghiêm trọng" value={number(s.critical_events)} detail="Cần ưu tiên điều tra" delta={s.critical_change_percent} inverse tone="orange"/>
   <Kpi icon={<Target/>} label="Tỷ lệ xử lý" value={s.resolution_rate.toFixed(1)+'%'} detail={number(s.resolved_events)+' cảnh báo đã đóng'} tone="green"/>
   <Kpi icon={<Clock3/>} label="Phản hồi trung bình" value={duration(s.average_acknowledge_seconds)} detail={'Xử lý TB '+duration(s.average_resolution_seconds)} tone="blue"/>
   <Kpi icon={<FileWarning/>} label="Sự cố phát sinh" value={number(s.incidents)} detail={number(s.overdue_incidents)+' hồ sơ quá hạn'} tone="violet"/>
   <Kpi icon={<Gauge/>} label="Độ tin cậy AI" value={percent(s.average_confidence)} detail={number(s.reporting_cameras)+' camera có dữ liệu'} tone="cyan"/>
  </section>
  <div className={styles.primaryGrid}><ReportTrendChart key={data.generated_at} rows={data.trend}/><SeverityPanel severities={data.severities} statuses={data.statuses} total={s.total_events}/></div>
  {data.response_metrics&&<ResponsePanel metrics={data.response_metrics}/>}
  <div className={styles.secondaryGrid}><EventTypes rows={data.event_types}/><Heatmap rows={data.heatmap}/></div>
  <SitePerformance rows={data.sites}/>
  <div className={styles.bottomGrid}><CameraRisks rows={data.cameras}/><RecentEvents rows={data.recent_events}/></div>
 </div>;
}

function PanelHeader({icon,title,subtitle,badge}:{icon:ReactNode;title:string;subtitle:string;badge?:string}){return <header className={styles.panelHead}><div><span>{icon}</span><p><strong>{title}</strong><small>{subtitle}</small></p></div>{badge&&<em>{badge}</em>}</header>;}

function ResponsePanel({metrics}:{metrics:ResponseMetrics}){
 const rate=metrics.acknowledge_samples?metrics.acknowledged_within_24h/metrics.acknowledge_samples*100:null;
 return <section className={styles.panel} aria-label="Hiệu quả tiếp nhận cảnh báo">
  <PanelHeader icon={<Clock3/>} title="Hiệu quả tiếp nhận cảnh báo" subtitle="Cảnh báo được phát hiện trong khoảng thời gian và cơ sở đã chọn"/>
  <div className={styles.responseSummary}>
   <article><span>Chờ xác nhận</span><strong>{number(metrics.pending_events)}</strong><small>Chỉ cảnh báo mới</small></article>
   <article><span>Đã xác nhận</span><strong>{number(metrics.acknowledged_events)}</strong><small>Đã rời hàng đợi tiếp nhận</small></article>
   <article data-risk={metrics.overdue_events>0}><span>Quá hạn xác nhận</span><strong>{number(metrics.overdue_events)}</strong><small>Quá 24 giờ, chưa xác nhận</small></article>
   <article><span>Xác nhận trong 24 giờ</span><strong>{rate===null?'—':rate.toLocaleString('vi-VN',{maximumFractionDigits:1})+'%'}</strong><small>{number(metrics.acknowledged_within_24h)} / {number(metrics.acknowledge_samples)} lượt đã xác nhận</small></article>
  </div>
  <div className={styles.responseTable}><table><caption>Thời gian từ lúc phát hiện đến khi phản hồi</caption><thead><tr><th scope="col">Thao tác</th><th scope="col">Số mẫu</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">P99</th></tr></thead><tbody>
   <tr><th scope="row">Xác nhận</th><td>{number(metrics.acknowledge_samples)}</td><td>{duration(metrics.acknowledge_p50_seconds)}</td><td>{duration(metrics.acknowledge_p95_seconds)}</td><td>{duration(metrics.acknowledge_p99_seconds)}</td></tr>
   <tr><th scope="row">Hoàn tất xử lý</th><td>{number(metrics.resolution_samples)}</td><td>{duration(metrics.resolution_p50_seconds)}</td><td>{duration(metrics.resolution_p95_seconds)}</td><td>{duration(metrics.resolution_p99_seconds)}</td></tr>
  </tbody></table></div>
  <p className={styles.responseNote}>P50 là trung vị; 95% số mẫu có thời gian không vượt P95, 99% không vượt P99. Chỉ tính mẫu có mốc thời gian hợp lệ. Tỷ lệ 24 giờ tính trên lượt đã xác nhận; các cảnh báo đang chờ được thống kê riêng ở trên.</p>
 </section>;
}

function SeverityPanel({severities,statuses,total}:{severities:NamedMetric[];statuses:NamedMetric[];total:number}){
 const colors=['#d94d53','#e48845','#e5b84b','#4aa983'];let cursor=0;
 const stops=severities.map((x,i)=>{const from=cursor;cursor+=x.percentage;return colors[i]+' '+from+'% '+cursor+'%';}).join(',');
 return <section className={styles.panel} aria-label="Cơ cấu rủi ro"><PanelHeader icon={<ShieldCheck/>} title="Cơ cấu rủi ro" subtitle="Theo mức độ và trạng thái xử lý"/><div className={styles.donutRow}><div className={styles.donut} style={{background:total?'conic-gradient('+stops+')':'#edf1ef'}}><span><strong>{number(total)}</strong><small>TỔNG LỖI</small></span></div><div className={styles.severityList}>{severities.map((x,i)=><div key={x.key}><i style={{background:colors[i]}}/><span><strong>{x.label}</strong><small>{x.percentage.toFixed(1)}%</small></span><b>{number(x.total)}</b></div>)}</div></div><div className={styles.statusFlow}>{statuses.map(x=><div key={x.key} data-status={x.key}><span><i/><strong>{x.label}</strong></span><b>{number(x.total)}</b><small>{x.percentage.toFixed(1)}%</small></div>)}</div></section>;
}

function EventTypes({rows}:{rows:EventType[]}){
 const max=Math.max(1,...rows.map(x=>x.total));
 return <section className={styles.panel} aria-label="Loại vi phạm phổ biến"><PanelHeader icon={<BarChart3/>} title="Loại vi phạm phổ biến" subtitle="Xếp hạng theo số lần phát hiện" badge="TOP 10"/><div className={styles.typeList}>{rows.length?rows.map((x,i)=><div key={x.code} className={styles.typeRow}><span className={styles.rank}>{String(i+1).padStart(2,'0')}</span><p><strong>{x.name}</strong><small>{x.code} · Tin cậy {percent(x.average_confidence)}</small></p><div><i><b style={{width:(x.total/max*100)+'%',background:x.color||'#537eea'}}/></i></div><em>{number(x.total)}</em><Delta value={x.change_percent} inverse/></div>):<Empty compact text="Chưa có loại vi phạm nào trong kỳ"/>}</div></section>;
}

function Heatmap({rows}:{rows:HeatCell[]}){
 const map=new Map(rows.map(x=>[x.weekday+'-'+x.hour,x.total])),max=Math.max(1,...rows.map(x=>x.total));
 const days=['T2','T3','T4','T5','T6','T7','CN'],hours=Array.from({length:24},(_,i)=>i);
 return <section className={styles.panel}><PanelHeader icon={<CalendarDays/>} title="Bản đồ thời gian rủi ro" subtitle="Khung giờ thường phát sinh cảnh báo (UTC)" badge="24 × 7"/><div className={styles.heatWrap}><div className={styles.hourLabels}>{hours.map(h=><span key={h}>{h%3===0?h.toString().padStart(2,'0'):''}</span>)}</div>{days.map((day,d)=><div className={styles.heatRow} key={day}><strong>{day}</strong><div>{hours.map(h=>{const value=map.get((d+1)+'-'+h)||0;return <i key={h} style={{'--alpha':String(value?Math.max(.16,value/max):.04)} as CSSProperties}><span>{day} {h}:00 · {value} cảnh báo</span></i>})}</div></div>)}<footer><span>Ít</span>{[.04,.16,.35,.6,1].map(n=><i key={n} style={{'--alpha':n} as CSSProperties}/>)}<span>Nhiều</span></footer>{!rows.length&&<p className={styles.heatEmpty}>Chưa có dữ liệu thời gian trong kỳ đã chọn.</p>}</div></section>;
}

function SitePerformance({rows}:{rows:Site[]}){
 const max=Math.max(1,...rows.map(x=>x.total));
 return <section className={styles.panel} aria-label="Hiệu suất an toàn theo cơ sở">
  <PanelHeader icon={<Factory/>} title="Hiệu suất an toàn theo cơ sở" subtitle="So sánh khối lượng cảnh báo và tỷ lệ xử lý" badge={rows.length+' CƠ SỞ'}/>
  {rows.length?<div className={styles.siteTable} tabIndex={0} role="region" aria-label="Bảng hiệu suất cơ sở">
   <table>
    <caption className={styles.srOnly}>Thống kê cảnh báo và xử lý theo từng cơ sở</caption>
    <colgroup><col className={styles.siteNameColumn}/><col className={styles.siteDistributionColumn}/><col className={styles.siteCountColumn}/><col className={styles.siteCountColumn}/><col className={styles.siteResolutionColumn}/><col className={styles.siteCameraColumn}/></colgroup>
    <thead><tr><th scope="col">Cơ sở</th><th scope="col">Phân bố cảnh báo</th><th scope="col">Nghiêm trọng</th><th scope="col">Đang mở</th><th scope="col">Tỷ lệ xử lý</th><th scope="col">Camera</th></tr></thead>
    <tbody>{rows.map((x,i)=><tr key={x.code}>
     <th scope="row"><div className={styles.siteIdentity}><span>{i+1}</span><div><strong>{x.name}</strong><small>{x.code}</small></div></div></th>
     <td><div className={styles.alertDistribution}><div className={styles.alertTrack} aria-hidden="true"><span style={{width:(x.total/max*100)+'%'}}/></div><strong>{number(x.total)}</strong></div></td>
     <td data-risk={x.critical>0}>{number(x.critical)}</td>
     <td>{number(x.open_events)}</td>
     <td><div className={styles.resolutionCell}><strong>{x.resolution_rate.toLocaleString('vi-VN',{minimumFractionDigits:1,maximumFractionDigits:1})}%</strong><div className={styles.resolutionTrack} aria-hidden="true"><span style={{width:Math.min(100,Math.max(0,x.resolution_rate))+'%'}}/></div></div></td>
     <td>{number(x.cameras)}</td>
    </tr>)}</tbody>
   </table>
  </div>:<Empty text="Chưa có dữ liệu để so sánh giữa các cơ sở"/>}
 </section>;
}
function CameraRisks({rows}:{rows:RiskCamera[]}){
 return <section className={styles.panel} aria-label="Camera rủi ro cao"><PanelHeader icon={<Camera/>} title="Camera rủi ro cao" subtitle="Nguồn hình cần kiểm tra và tối ưu" badge="TOP 8"/><div className={styles.cameraList}>{rows.length?rows.map((x,i)=><article key={x.code}><span className={styles.cameraRank} data-top={i<3}>{i+1}</span><div><strong>{x.code} · {x.name}</strong><small>{x.site_name} · {x.zone_name||'Chưa phân khu'}</small></div><p><strong>{number(x.total)}</strong><small>cảnh báo</small></p><p data-critical={x.critical>0}><strong>{x.critical}</strong><small>nghiêm trọng</small></p><em data-online={x.status==='online'}><i/>{cameraStatusLabel[x.status]||x.status}</em></article>):<Empty compact text="Chưa xác định camera rủi ro trong kỳ"/>}</div></section>;
}

function RecentEvents({rows}:{rows:RecentEvent[]}){
 return <section className={styles.panel} aria-label="Cảnh báo gần đây"><PanelHeader icon={<Activity/>} title="Cảnh báo gần đây" subtitle="Dữ liệu nguồn mới nhất từ hệ thống"/><div className={styles.recentList}>{rows.length?rows.slice(0,8).map(x=><article key={x.id}><span data-severity={x.severity}><Siren/></span><div><strong>{x.title}</strong><small>{x.camera_code} · {x.site_name} · {fullTime(x.detected_at)}</small></div><p><em data-severity={x.severity}>{severityLabel[x.severity]}</em><small>{percent(x.confidence)}</small></p><b data-status={x.status}>{statusLabel[x.status]}</b></article>):<Empty compact text="Chưa có cảnh báo mới trong khoảng thời gian này"/>}</div></section>;
}

function Empty({text,compact=false}:{text:string;compact?:boolean}){return <div className={compact?styles.empty+' '+styles.compact:styles.empty}><span><BarChart3/></span><strong>Chưa có dữ liệu</strong><small>{text}</small></div>;}

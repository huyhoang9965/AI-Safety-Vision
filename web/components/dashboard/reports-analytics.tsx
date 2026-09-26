'use client';

import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3,
  CalendarDays, Camera, ChevronDown, Clock3, Download,
  Factory, FileWarning, Gauge, LoaderCircle, MapPin, RefreshCw, ShieldCheck,
  Siren, Target, TrendingUp, X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { readAuthSession } from '@/lib/auth';
import styles from './reports-analytics.module.css';

const API_BASE=(process.env.NEXT_PUBLIC_API_URL||'http://localhost:8000').replace(/\/$/,'');
type Period='7d'|'30d'|'90d'|'365d';
type NamedMetric={key:string;label:string;total:number;percentage:number};
type Trend={day:string;total:number;critical:number;resolved:number;incidents:number};
type EventType={code:string;name:string;color:string|null;total:number;previous_total:number;change_percent:number|null;average_confidence:number|null};
type Site={code:string;name:string;total:number;critical:number;open_events:number;resolved:number;resolution_rate:number;cameras:number};
type RiskCamera={code:string;name:string;site_name:string;zone_name:string|null;status:string;total:number;critical:number;average_confidence:number|null};
type HeatCell={weekday:number;hour:number;total:number};
type RecentEvent={id:string;title:string;event_code:string;event_name:string;severity:'low'|'medium'|'high'|'critical';status:'new'|'acknowledged'|'resolved'|'dismissed';confidence:number|null;detected_at:string;site_name:string;zone_name:string|null;camera_code:string;camera_name:string;snapshot_url:string|null};
type ReportData={
 period:{days:number;start_at:string;end_at:string;previous_start_at:string};
 summary:{total_events:number;previous_events:number;event_change_percent:number|null;critical_events:number;critical_change_percent:number|null;open_events:number;resolved_events:number;resolution_rate:number;average_acknowledge_seconds:number|null;average_resolution_seconds:number|null;average_confidence:number|null;incidents:number;overdue_incidents:number;reporting_cameras:number};
 trend:Trend[];event_types:EventType[];severities:NamedMetric[];statuses:NamedMetric[];
 sites:Site[];cameras:RiskCamera[];heatmap:HeatCell[];recent_events:RecentEvent[];
 filters:{sites:Array<{code:string;name:string}>};generated_at:string;
};

const PERIODS:Array<{value:Period;label:string}>=[
 {value:'7d',label:'7 ngày'},{value:'30d',label:'30 ngày'},
 {value:'90d',label:'90 ngày'},{value:'365d',label:'12 tháng'},
];
const severityLabel={critical:'Nghiêm trọng',high:'Cao',medium:'Trung bình',low:'Thấp'};
const statusLabel={new:'Mới',acknowledged:'Đã xác nhận',resolved:'Đã xử lý',dismissed:'Bỏ qua'};

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
 const load=useCallback(async()=>{setLoading(true);setError('');const query=new URLSearchParams({period});if(site)query.set('site',site);try{const response=await fetch(API_BASE+'/api/reports/overview?'+query,{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setData(payload as ReportData);}catch(reason){setError(reason instanceof Error?reason.message:'Không thể tải báo cáo.');}finally{setLoading(false);}},[period,site]);
 useEffect(()=>{void load();},[load]);
 async function exportReport(){setExporting(true);setError('');const query=new URLSearchParams({period});if(site)query.set('site',site);try{const response=await fetch(API_BASE+'/api/reports/export?'+query,{headers:headers()});if(!response.ok)throw new Error(apiError(await response.json().catch(()=>null)));const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='bao-cao-an-toan-'+period+'.csv';link.click();URL.revokeObjectURL(url);}catch(reason){setError(reason instanceof Error?reason.message:'Không thể xuất báo cáo.');}finally{setExporting(false);}}
 if(!data&&loading)return <div className={styles.loading}><LoaderCircle/><strong>Đang tổng hợp dữ liệu an toàn</strong><span>Phân tích sự kiện, sự cố và hiệu suất xử lý...</span></div>;
 if(!data)return <div className={styles.loading}><AlertTriangle/><strong>Không thể mở báo cáo</strong><span>{error}</span><button onClick={()=>void load()}><RefreshCw/>Thử lại</button></div>;
 const s=data.summary;
 return <div className={styles.page}>
  <header className={styles.heading}><div><span className={styles.eyebrow}><BarChart3/> SAFETY INTELLIGENCE</span><h1>Báo cáo & thống kê</h1><p>Đo lường xu hướng rủi ro, hiệu quả phản ứng và các điểm nóng cần ưu tiên.</p></div><div className={styles.actions}><label><MapPin/><select value={site} onChange={e=>setSite(e.target.value)}><option value="">Tất cả cơ sở</option>{data.filters.sites.map(x=><option key={x.code} value={x.code}>{x.name}</option>)}</select><ChevronDown/></label><button onClick={()=>void load()} disabled={loading} title="Làm mới"><RefreshCw className={loading?styles.spin:''}/></button><button className={styles.export} onClick={()=>void exportReport()} disabled={exporting}>{exporting?<LoaderCircle className={styles.spin}/>:<Download/>}Xuất CSV</button></div></header>
  <section className={styles.periodBar}><div className={styles.periods}>{PERIODS.map(item=><button key={item.value} className={period===item.value?styles.activePeriod:''} onClick={()=>setPeriod(item.value)}>{item.label}</button>)}</div><span><CalendarDays/> {fullTime(data.period.start_at)} — {fullTime(data.period.end_at)}</span><em><i/>Dữ liệu cập nhật {fullTime(data.generated_at)}</em></section>
  {error&&<div className={styles.error}><AlertTriangle/><span>{error}</span><button onClick={()=>setError('')}><X/></button></div>}
  <section className={styles.kpis}>
   <Kpi icon={<Siren/>} label="Tổng cảnh báo" value={number(s.total_events)} detail={number(s.open_events)+' cảnh báo đang mở'} delta={s.event_change_percent} inverse tone="red"/>
   <Kpi icon={<AlertTriangle/>} label="Mức nghiêm trọng" value={number(s.critical_events)} detail="Cần ưu tiên điều tra" delta={s.critical_change_percent} inverse tone="orange"/>
   <Kpi icon={<Target/>} label="Tỷ lệ xử lý" value={s.resolution_rate.toFixed(1)+'%'} detail={number(s.resolved_events)+' cảnh báo đã đóng'} tone="green"/>
   <Kpi icon={<Clock3/>} label="Phản hồi trung bình" value={duration(s.average_acknowledge_seconds)} detail={'Xử lý TB '+duration(s.average_resolution_seconds)} tone="blue"/>
   <Kpi icon={<FileWarning/>} label="Sự cố phát sinh" value={number(s.incidents)} detail={number(s.overdue_incidents)+' hồ sơ quá hạn'} tone="violet"/>
   <Kpi icon={<Gauge/>} label="Độ tin cậy AI" value={percent(s.average_confidence)} detail={number(s.reporting_cameras)+' camera có dữ liệu'} tone="cyan"/>
  </section>
  <div className={styles.primaryGrid}><TrendChart rows={data.trend} period={period}/><SeverityPanel severities={data.severities} statuses={data.statuses} total={s.total_events}/></div>
  <div className={styles.secondaryGrid}><EventTypes rows={data.event_types}/><Heatmap rows={data.heatmap}/></div>
  <SitePerformance rows={data.sites}/>
  <div className={styles.bottomGrid}><CameraRisks rows={data.cameras}/><RecentEvents rows={data.recent_events}/></div>
 </div>;
}

function PanelHeader({icon,title,subtitle,badge}:{icon:ReactNode;title:string;subtitle:string;badge?:string}){return <header className={styles.panelHead}><div><span>{icon}</span><p><strong>{title}</strong><small>{subtitle}</small></p></div>{badge&&<em>{badge}</em>}</header>;}

function TrendChart({rows,period}:{rows:Trend[];period:Period}){
 const width=900,height=250,pad=22,max=Math.max(1,...rows.map(x=>x.total));
 const points=rows.map((item,i)=>({x:pad+i*(width-pad*2)/Math.max(rows.length-1,1),y:height-pad-item.total/max*(height-pad*2),...item}));
 const line=points.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ');
 const area=line+(points.length?' L '+points.at(-1)!.x+' '+(height-pad)+' L '+points[0].x+' '+(height-pad)+' Z':'');
 const labels=rows.filter((_,i)=>i===0||i===rows.length-1||i%Math.max(1,Math.floor(rows.length/5))===0);
 const total=rows.reduce((a,x)=>a+x.total,0),critical=rows.reduce((a,x)=>a+x.critical,0),resolved=rows.reduce((a,x)=>a+x.resolved,0);
 return <section className={styles.panel+' '+styles.trend}><PanelHeader icon={<TrendingUp/>} title="Xu hướng cảnh báo" subtitle="Diễn biến số lượng phát hiện theo thời gian" badge={period==='365d'?'12 THÁNG':rows.length+' NGÀY'}/><div className={styles.legend}><span><i data-color="total"/>Tổng cảnh báo <b>{number(total)}</b></span><span><i data-color="critical"/>Nghiêm trọng <b>{number(critical)}</b></span><span><i data-color="resolved"/>Đã xử lý <b>{number(resolved)}</b></span></div><div className={styles.chartWrap}><svg viewBox={'0 0 '+width+' '+height} preserveAspectRatio="none" aria-label="Biểu đồ xu hướng cảnh báo">{[0,.25,.5,.75,1].map(n=><line key={n} x1={pad} x2={width-pad} y1={pad+n*(height-pad*2)} y2={pad+n*(height-pad*2)} className={styles.gridLine}/>)}
  <defs><linearGradient id="reportArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2f75ef" stopOpacity=".23"/><stop offset="1" stopColor="#2f75ef" stopOpacity=".01"/></linearGradient></defs><path d={area} fill="url(#reportArea)"/><path d={line} className={styles.line}/>{points.filter((_,i)=>rows.length<=30||i%Math.ceil(rows.length/30)===0).map(p=><circle key={p.day} cx={p.x} cy={p.y} r="3" className={styles.point}><title>{p.day}: {p.total} cảnh báo</title></circle>)}</svg><div className={styles.xLabels}>{labels.map(x=><span key={x.day}>{new Date(x.day+'T00:00:00').toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit'})}</span>)}</div>{!total&&<div className={styles.chartEmpty}><Activity/><strong>Chưa có dữ liệu trong kỳ</strong><small>Các cảnh báo mới sẽ tự động xuất hiện trên biểu đồ.</small></div>}</div></section>;
}

function SeverityPanel({severities,statuses,total}:{severities:NamedMetric[];statuses:NamedMetric[];total:number}){
 const colors=['#d94d53','#e48845','#e5b84b','#4aa983'];let cursor=0;
 const stops=severities.map((x,i)=>{const from=cursor;cursor+=x.percentage;return colors[i]+' '+from+'% '+cursor+'%';}).join(',');
 return <section className={styles.panel}><PanelHeader icon={<ShieldCheck/>} title="Cơ cấu rủi ro" subtitle="Theo mức độ và trạng thái xử lý"/><div className={styles.donutRow}><div className={styles.donut} style={{background:total?'conic-gradient('+stops+')':'#edf1ef'}}><span><strong>{number(total)}</strong><small>TỔNG LỖI</small></span></div><div className={styles.severityList}>{severities.map((x,i)=><div key={x.key}><i style={{background:colors[i]}}/><span><strong>{x.label}</strong><small>{x.percentage.toFixed(1)}%</small></span><b>{number(x.total)}</b></div>)}</div></div><div className={styles.statusFlow}>{statuses.map(x=><div key={x.key} data-status={x.key}><span><i/><strong>{x.label}</strong></span><b>{number(x.total)}</b><small>{x.percentage.toFixed(1)}%</small></div>)}</div></section>;
}

function EventTypes({rows}:{rows:EventType[]}){
 const max=Math.max(1,...rows.map(x=>x.total));
 return <section className={styles.panel}><PanelHeader icon={<BarChart3/>} title="Loại vi phạm phổ biến" subtitle="Xếp hạng theo số lần phát hiện" badge="TOP 10"/><div className={styles.typeList}>{rows.length?rows.map((x,i)=><div key={x.code} className={styles.typeRow}><span className={styles.rank}>{String(i+1).padStart(2,'0')}</span><p><strong>{x.name}</strong><small>{x.code} · Tin cậy {percent(x.average_confidence)}</small></p><div><i><b style={{width:(x.total/max*100)+'%',background:x.color||'#537eea'}}/></i></div><em>{number(x.total)}</em><Delta value={x.change_percent} inverse/></div>):<Empty compact text="Chưa có loại vi phạm nào trong kỳ"/>}</div></section>;
}

function Heatmap({rows}:{rows:HeatCell[]}){
 const map=new Map(rows.map(x=>[x.weekday+'-'+x.hour,x.total])),max=Math.max(1,...rows.map(x=>x.total));
 const days=['T2','T3','T4','T5','T6','T7','CN'],hours=Array.from({length:24},(_,i)=>i);
 return <section className={styles.panel}><PanelHeader icon={<CalendarDays/>} title="Bản đồ thời gian rủi ro" subtitle="Khung giờ thường phát sinh cảnh báo" badge="24 × 7"/><div className={styles.heatWrap}><div className={styles.hourLabels}>{hours.map(h=><span key={h}>{h%3===0?h.toString().padStart(2,'0'):''}</span>)}</div>{days.map((day,d)=><div className={styles.heatRow} key={day}><strong>{day}</strong><div>{hours.map(h=>{const value=map.get((d+1)+'-'+h)||0;return <i key={h} style={{'--alpha':String(value?Math.max(.16,value/max):.04)} as CSSProperties}><span>{day} {h}:00 · {value} cảnh báo</span></i>})}</div></div>)}<footer><span>Ít</span>{[.04,.16,.35,.6,1].map(n=><i key={n} style={{'--alpha':n} as CSSProperties}/>)}<span>Nhiều</span></footer>{!rows.length&&<p className={styles.heatEmpty}>Chưa có dữ liệu thời gian trong kỳ đã chọn.</p>}</div></section>;
}

function SitePerformance({rows}:{rows:Site[]}){
 const max=Math.max(1,...rows.map(x=>x.total));
 return <section className={styles.panel}><PanelHeader icon={<Factory/>} title="Hiệu suất an toàn theo cơ sở" subtitle="So sánh khối lượng cảnh báo và tỷ lệ xử lý" badge={rows.length+' CƠ SỞ'}/>{rows.length?<div className={styles.siteTable}><div className={styles.siteHead}><span>Cơ sở</span><span>Phân bố cảnh báo</span><span>Nghiêm trọng</span><span>Đang mở</span><span>Tỷ lệ xử lý</span><span>Camera</span></div>{rows.map((x,i)=><div className={styles.siteRow} key={x.code}><span><i>{i+1}</i><p><strong>{x.name}</strong><small>{x.code}</small></p></span><span><b style={{width:(x.total/max*100)+'%'}}/><em>{number(x.total)}</em></span><span data-risk={x.critical>0}>{number(x.critical)}</span><span>{number(x.open_events)}</span><span><strong>{x.resolution_rate.toFixed(1)}%</strong><i><b style={{width:x.resolution_rate+'%'}}/></i></span><span>{x.cameras}</span></div>)}</div>:<Empty text="Chưa có dữ liệu để so sánh giữa các cơ sở"/>}</section>;
}

function CameraRisks({rows}:{rows:RiskCamera[]}){
 return <section className={styles.panel}><PanelHeader icon={<Camera/>} title="Camera rủi ro cao" subtitle="Nguồn hình cần kiểm tra và tối ưu" badge="TOP 8"/><div className={styles.cameraList}>{rows.length?rows.map((x,i)=><article key={x.code}><span className={styles.cameraRank} data-top={i<3}>{i+1}</span><div><strong>{x.code} · {x.name}</strong><small>{x.site_name} · {x.zone_name||'Chưa phân khu'}</small></div><p><strong>{number(x.total)}</strong><small>cảnh báo</small></p><p data-critical={x.critical>0}><strong>{x.critical}</strong><small>nghiêm trọng</small></p><em data-online={x.status==='online'}><i/>{x.status}</em></article>):<Empty compact text="Chưa xác định camera rủi ro trong kỳ"/>}</div></section>;
}

function RecentEvents({rows}:{rows:RecentEvent[]}){
 return <section className={styles.panel}><PanelHeader icon={<Activity/>} title="Cảnh báo gần đây" subtitle="Dữ liệu nguồn mới nhất từ hệ thống"/><div className={styles.recentList}>{rows.length?rows.slice(0,8).map(x=><article key={x.id}><span data-severity={x.severity}><Siren/></span><div><strong>{x.title}</strong><small>{x.camera_code} · {x.site_name} · {fullTime(x.detected_at)}</small></div><p><em data-severity={x.severity}>{severityLabel[x.severity]}</em><small>{percent(x.confidence)}</small></p><b data-status={x.status}>{statusLabel[x.status]}</b></article>):<Empty compact text="Chưa có cảnh báo mới trong khoảng thời gian này"/>}</div></section>;
}

function Empty({text,compact=false}:{text:string;compact?:boolean}){return <div className={compact?styles.empty+' '+styles.compact:styles.empty}><span><BarChart3/></span><strong>Chưa có dữ liệu</strong><small>{text}</small></div>;}

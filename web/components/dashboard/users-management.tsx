'use client';

import {
  Activity, AlertTriangle, Building2, Check, CheckCircle2, ChevronRight,
  CircleDot, Clock3, Edit3, Eye, Filter, Fingerprint, History, KeyRound,
  Laptop, LoaderCircle, Lock, LockKeyhole, Mail, MapPin, MoreHorizontal,
  Plus, RefreshCw, Search, Shield, ShieldCheck, ShieldOff, Smartphone,
  UserCheck, UserCog, UserRound, Users, UserX, X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { readAuthSession, userPermissions } from '@/lib/auth';
import styles from './users-management.module.css';

const API_BASE=(process.env.NEXT_PUBLIC_API_URL||'http://localhost:8000').replace(/\/$/,'');
type UserStatus='pending'|'active'|'locked'|'disabled';
type Permission={id:string;code:string;name:string;description:string|null};
type Role={id:string;code:string;name:string;description:string|null;is_system:boolean;permissions:string[];member_count:number};
type Site={id:string;code:string;name:string};
type ManagedUser={id:string;email:string;username:string|null;full_name:string;department:string|null;job_title:string|null;phone:string|null;avatar_url:string|null;status:UserStatus;email_verified:boolean;last_login_at:string|null;failed_login_count:number;locked_until:string|null;created_at:string;role_id:string;role_code:string;role_name:string;permissions:string[];site_ids:string[];site_count:number;active_sessions:number;must_change_password:boolean};
type LoginActivity={id:number;succeeded:boolean;failure_reason:string|null;ip_address:string|null;user_agent:string|null;attempted_at:string};
type AuditActivity={id:number;action:string;entity_type:string;entity_id:string|null;created_at:string;actor_name:string|null};
type SessionItem={id:string;ip_address:string|null;user_agent:string|null;device_name:string|null;created_at:string;last_used_at:string|null;expires_at:string};
type UserDetail=ManagedUser&{login_activity:LoginActivity[];audit_activity:AuditActivity[];sessions:SessionItem[]};
type Summary={total:number;active:number;pending:number;locked:number;disabled:number;admins:number;active_sessions:number};
type ResponseData={users:ManagedUser[];roles:Role[];permissions:Permission[];sites:Site[];summary:Summary;organization_name:string};
type UserForm={email:string;temporary_password:string;full_name:string;username:string;department:string;job_title:string;phone:string;role_id:string;site_ids:string[];status:UserStatus};
type Editor={mode:'create'|'edit';id?:string}|null;

const EMPTY_SUMMARY:Summary={total:0,active:0,pending:0,locked:0,disabled:0,admins:0,active_sessions:0};
const statusLabels:Record<UserStatus,string>={active:'Đang hoạt động',pending:'Chờ kích hoạt',locked:'Đã khóa',disabled:'Vô hiệu hóa'};
const roleDescriptions:Record<string,string>={org_admin:'Toàn quyền quản trị trong tổ chức',safety_manager:'Điều phối sự kiện và sự cố an toàn',operator:'Theo dõi và xử lý cảnh báo',viewer:'Chỉ xem dashboard và báo cáo',camera_employee:'Chỉ xem màn hình camera'};
const permissionGroups=[
  {name:'Tổng quan',prefixes:['dashboard.','report.']},
  {name:'Camera & địa điểm',prefixes:['camera.','site.']},
  {name:'Sự kiện & sự cố',prefixes:['event.','incident.','alert.']},
  {name:'Quản trị',prefixes:['user.','audit.','settings.']},
];

function headers():HeadersInit{const stored=readAuthSession();return{'Content-Type':'application/json',...(stored?{Authorization:'Bearer '+stored.session.access_token}:{})};}
function apiError(payload:unknown):string{return payload&&typeof payload==='object'&&'detail'in payload?String((payload as {detail:unknown}).detail):'Không thể hoàn thành yêu cầu.';}
function initials(name:string):string{return name.split(/\s+/).filter(Boolean).slice(-2).map(item=>item[0]).join('').toUpperCase();}
function dateTime(value:string|null):string{return value?new Intl.DateTimeFormat('vi-VN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Chưa có dữ liệu';}
function relative(value:string|null):string{if(!value)return'Chưa đăng nhập';const sec=Math.max(0,(Date.now()-new Date(value).getTime())/1000);if(sec<60)return'Vừa xong';if(sec<3600)return Math.floor(sec/60)+' phút trước';if(sec<86400)return Math.floor(sec/3600)+' giờ trước';return Math.floor(sec/86400)+' ngày trước';}
function emptyForm(role=''):UserForm{return{email:'',temporary_password:'',full_name:'',username:'',department:'',job_title:'',phone:'',role_id:role,site_ids:[],status:'active'};}

export default function UsersManagement(){
  const [data,setData]=useState<ResponseData>({users:[],roles:[],permissions:[],sites:[],summary:EMPTY_SUMMARY,organization_name:''});
  const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const [tab,setTab]=useState<'users'|'roles'>('users');const [search,setSearch]=useState('');
  const [status,setStatus]=useState<'all'|UserStatus>('all');const [role,setRole]=useState('all');
  const [selectedId,setSelectedId]=useState('');const [detail,setDetail]=useState<UserDetail|null>(null);
  const [detailLoading,setDetailLoading]=useState(false);const [detailTab,setDetailTab]=useState<'profile'|'security'|'activity'>('profile');
  const [mobileDetail,setMobileDetail]=useState(false);const [editor,setEditor]=useState<Editor>(null);
  const [form,setForm]=useState<UserForm>(emptyForm());const [statusModal,setStatusModal]=useState<UserStatus|null>(null);
  const [passwordModal,setPasswordModal]=useState(false);const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);const [toast,setToast]=useState('');
  const auth=useMemo(()=>typeof window==='undefined'?null:readAuthSession(),[]);
  const permissions=useMemo(()=>auth?userPermissions(auth.session.user):new Set<string>(),[auth]);
  const canManage=permissions.has('user.manage');const currentUserId=auth?.session.user.id||'';

  const loadData=useCallback(async(quiet=false)=>{if(!quiet)setLoading(true);setError('');try{const response=await fetch(API_BASE+'/api/users',{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));const next=payload as ResponseData;setData(next);setSelectedId(current=>next.users.some(item=>item.id===current)?current:next.users[0]?.id||'');}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải người dùng.');}finally{setLoading(false);}},[]);
  useEffect(()=>{void loadData();},[loadData]);
  const loadDetail=useCallback(async(id:string)=>{if(!id){setDetail(null);return;}setDetailLoading(true);try{const response=await fetch(API_BASE+'/api/users/'+id,{headers:headers()});const payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(payload));setDetail(payload as UserDetail);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể tải hồ sơ người dùng.');}finally{setDetailLoading(false);}},[]);
  useEffect(()=>{void loadDetail(selectedId);},[selectedId,loadDetail]);

  const filtered=useMemo(()=>data.users.filter(item=>{const text=[item.full_name,item.email,item.department||'',item.job_title||'',item.role_name].join(' ').toLowerCase();return(!search.trim()||text.includes(search.toLowerCase()))&&(status==='all'||item.status===status)&&(role==='all'||item.role_id===role);}),[data.users,search,status,role]);
  function notify(message:string){setToast(message);window.setTimeout(()=>setToast(''),2800);}
  function selectUser(id:string){setSelectedId(id);setDetailTab('profile');setMobileDetail(true);}
  function openCreate(){setForm(emptyForm(data.roles[0]?.id||''));setEditor({mode:'create'});}
  function openEdit(item:ManagedUser){setForm({email:item.email,temporary_password:'',full_name:item.full_name,username:item.username||'',department:item.department||'',job_title:item.job_title||'',phone:item.phone||'',role_id:item.role_id,site_ids:item.site_ids,status:item.status});setEditor({mode:'edit',id:item.id});}
  async function submitUser(event:FormEvent){event.preventDefault();if(!editor)return;setBusy(true);try{const payload={...form,username:form.username||null,department:form.department||null,job_title:form.job_title||null,phone:form.phone||null,...(editor.mode==='edit'?{temporary_password:undefined}:{})};const path='/api/users'+(editor.mode==='edit'?'/'+editor.id+'/update':'');const response=await fetch(API_BASE+path,{method:'POST',headers:headers(),body:JSON.stringify(payload)});const result=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(result));setEditor(null);notify((result as {message?:string})?.message||'Đã lưu người dùng');await loadData(true);const id=(result as {user_id?:string})?.user_id||selectedId;if(id){setSelectedId(id);await loadDetail(id);}}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể lưu người dùng.');}finally{setBusy(false);}}
  async function changeStatus(){if(!detail||!statusModal)return;setBusy(true);try{const response=await fetch(API_BASE+'/api/users/'+detail.id+'/status',{method:'POST',headers:headers(),body:JSON.stringify({status:statusModal})});const result=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(result));setStatusModal(null);notify('Đã cập nhật trạng thái tài khoản');await loadData(true);await loadDetail(detail.id);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể đổi trạng thái.');}finally{setBusy(false);}}
  async function resetPassword(event:FormEvent){event.preventDefault();if(!detail)return;setBusy(true);try{const response=await fetch(API_BASE+'/api/users/'+detail.id+'/reset-password',{method:'POST',headers:headers(),body:JSON.stringify({temporary_password:password})});const result=await response.json().catch(()=>null);if(!response.ok)throw new Error(apiError(result));setPasswordModal(false);setPassword('');notify('Đã đặt mật khẩu tạm và thu hồi phiên cũ');await loadData(true);await loadDetail(detail.id);}catch(requestError){setError(requestError instanceof Error?requestError.message:'Không thể đặt lại mật khẩu.');}finally{setBusy(false);}}

  return <div className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>QUẢN TRỊ TRUY CẬP</span><h1>Người dùng & phân quyền</h1><p>Kiểm soát tài khoản, vai trò, phạm vi dữ liệu và hoạt động bảo mật trong {data.organization_name||'tổ chức'}.</p></div><div className={styles.headerActions}><button className={styles.secondaryButton} onClick={()=>void loadData()} disabled={loading}><RefreshCw size={16} className={loading?styles.spin:''}/> Đồng bộ</button>{canManage&&<button className={styles.primaryButton} onClick={openCreate}><Plus size={17}/> Thêm người dùng</button>}</div></header>
    {error&&<div className={styles.errorBanner}><AlertTriangle size={17}/><span>{error}</span><button onClick={()=>setError('')}><X size={15}/></button></div>}
    <section className={styles.metrics}>
      <article><span data-tone="blue"><Users size={19}/></span><div><small>Tổng tài khoản</small><strong>{data.summary.total}</strong><em>Trong {data.organization_name||'tổ chức'}</em></div></article>
      <article><span data-tone="green"><UserCheck size={19}/></span><div><small>Đang hoạt động</small><strong>{data.summary.active}</strong><em>{data.summary.total?Math.round(data.summary.active/data.summary.total*100):0}% tài khoản</em></div></article>
      <article><span data-tone="amber"><Clock3 size={19}/></span><div><small>Chờ kích hoạt</small><strong>{data.summary.pending}</strong><em>Cần xác minh hoặc phê duyệt</em></div></article>
      <article><span data-tone="red"><LockKeyhole size={19}/></span><div><small>Bị giới hạn</small><strong>{data.summary.locked+data.summary.disabled}</strong><em>{data.summary.locked} khóa · {data.summary.disabled} vô hiệu</em></div></article>
      <article><span data-tone="violet"><ShieldCheck size={19}/></span><div><small>Quản trị viên</small><strong>{data.summary.admins}</strong><em>{data.summary.active_sessions} phiên đang hoạt động</em></div></article>
    </section>

    <section className={styles.panel}>
      <div className={styles.tabs}><button className={tab==='users'?styles.activeTab:''} onClick={()=>setTab('users')}><Users size={15}/> Người dùng <b>{data.summary.total}</b></button><button className={tab==='roles'?styles.activeTab:''} onClick={()=>setTab('roles')}><Shield size={15}/> Vai trò & ma trận quyền <b>{data.roles.length}</b></button></div>
      {tab==='users'?<>
        <div className={styles.toolbar}><label className={styles.search}><Search size={16}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Tìm tên, email, phòng ban..."/>{search&&<button onClick={()=>setSearch('')}><X size={14}/></button>}</label><label className={styles.filter}><Filter size={15}/><select value={status} onChange={event=>setStatus(event.target.value as 'all'|UserStatus)}><option value="all">Mọi trạng thái</option>{Object.entries(statusLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className={styles.filter}><Shield size={15}/><select value={role} onChange={event=>setRole(event.target.value)}><option value="all">Mọi vai trò</option>{data.roles.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className={styles.resultCount}>{filtered.length} kết quả</span></div>
        {loading?<div className={styles.loading}><LoaderCircle className={styles.spin}/><strong>Đang tải người dùng</strong><span>Đồng bộ vai trò và quyền truy cập...</span></div>:!filtered.length?<div className={styles.empty}><span><Search size={26}/></span><h3>Không tìm thấy người dùng</h3><p>Hãy thay đổi từ khóa hoặc bộ lọc đang chọn.</p><button className={styles.secondaryButton} onClick={()=>{setSearch('');setStatus('all');setRole('all');}}>Xóa bộ lọc</button></div>:<div className={styles.tableWrap}><table><thead><tr><th>Người dùng</th><th>Vai trò</th><th>Phòng ban</th><th>Phạm vi site</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th><th/></tr></thead><tbody>{filtered.map(item=><tr key={item.id} className={selectedId===item.id?styles.activeRow:''} onClick={()=>selectUser(item.id)}><td><div className={styles.userCell}><span>{item.avatar_url?<img src={item.avatar_url} alt=""/>:initials(item.full_name)}</span><div><strong>{item.full_name}{item.id===currentUserId&&<em>Bạn</em>}</strong><small>{item.email}</small></div></div></td><td><span className={styles.roleBadge} data-role={item.role_code}><Shield size={12}/>{item.role_name}</span><small>{item.permissions.length} quyền</small></td><td><strong>{item.department||'Chưa cập nhật'}</strong><small>{item.job_title||'—'}</small></td><td><strong>{item.site_count?item.site_count+' nhà máy':'Toàn bộ nhà máy'}</strong><small>{item.site_count?'Phạm vi giới hạn':'Theo tổ chức'}</small></td><td><span className={styles.statusBadge} data-status={item.status}><i/>{statusLabels[item.status]}</span>{item.must_change_password&&<small className={styles.passwordFlag}>Cần đổi mật khẩu</small>}</td><td><strong>{relative(item.last_login_at)}</strong><small>{item.active_sessions} phiên hoạt động</small></td><td><ChevronRight size={16}/></td></tr>)}</tbody></table></div>}
      </>:<RolesView roles={data.roles} permissions={data.permissions}/>}
    </section>

    <aside className={`${styles.drawer} ${mobileDetail?styles.drawerOpen:''}`}>
      <div className={styles.drawerHeader}><div><span>HỒ SƠ NGƯỜI DÙNG</span>{detail&&<em className={styles.statusBadge} data-status={detail.status}><i/>{statusLabels[detail.status]}</em>}</div><button onClick={()=>setMobileDetail(false)}><X size={18}/></button></div>
      {detailLoading?<div className={styles.drawerLoading}><LoaderCircle className={styles.spin}/></div>:detail?<>
        <div className={styles.profileHero}><span>{detail.avatar_url?<img src={detail.avatar_url} alt=""/>:initials(detail.full_name)}</span><div><h2>{detail.full_name}</h2><p>{detail.email}</p><small>{detail.job_title||'Chưa có chức danh'} · {detail.department||'Chưa có phòng ban'}</small></div>{canManage&&<button onClick={()=>openEdit(detail)}><Edit3 size={15}/> Sửa</button>}</div>
        <div className={styles.drawerTabs}><button className={detailTab==='profile'?styles.selectedTab:''} onClick={()=>setDetailTab('profile')}>Tổng quan</button><button className={detailTab==='security'?styles.selectedTab:''} onClick={()=>setDetailTab('security')}>Bảo mật</button><button className={detailTab==='activity'?styles.selectedTab:''} onClick={()=>setDetailTab('activity')}>Hoạt động</button></div>
        <div className={styles.drawerScroll}>{detailTab==='profile'?<ProfileTab user={detail} roles={data.roles} sites={data.sites}/>:detailTab==='security'?<SecurityTab user={detail}/>:<ActivityTab user={detail}/>}</div>
        {canManage&&<div className={styles.drawerActions}><button onClick={()=>{setPassword('');setPasswordModal(true);}}><KeyRound size={15}/> Đặt mật khẩu tạm</button><button disabled={detail.id===currentUserId} data-danger={detail.status==='active'} onClick={()=>setStatusModal(detail.status==='active'?'locked':'active')}>{detail.status==='active'?<Lock size={15}/>:<UserCheck size={15}/>} {detail.status==='active'?'Khóa tài khoản':'Kích hoạt lại'}</button></div>}
      </>:<div className={styles.drawerEmpty}><UserRound size={30}/><p>Chọn một người dùng để xem hồ sơ.</p></div>}
    </aside>

    {editor&&<UserEditor mode={editor.mode} form={form} roles={data.roles} sites={data.sites} busy={busy} setForm={setForm} close={()=>setEditor(null)} submit={submitUser}/>}
    {statusModal&&detail&&<ConfirmStatus user={detail} status={statusModal} busy={busy} close={()=>setStatusModal(null)} confirm={()=>void changeStatus()}/>}
    {passwordModal&&detail&&<PasswordModal user={detail} password={password} setPassword={setPassword} busy={busy} close={()=>setPasswordModal(false)} submit={resetPassword}/>}
    {toast&&<div className={styles.toast}><CheckCircle2 size={17}/>{toast}</div>}
  </div>;
}

function RolesView({roles,permissions}:{roles:Role[];permissions:Permission[]}){
  const permissionName=new Map(permissions.map(item=>[item.code,item.name]));
  return <div className={styles.rolesView}>
    <div className={styles.rolesIntro}><div><span><ShieldCheck size={20}/></span><div><strong>Mô hình phân quyền theo vai trò</strong><p>Mỗi người dùng nhận quyền từ một vai trò trong tổ chức. Vai trò hệ thống được khóa cấu trúc để tránh thay đổi quyền ngoài ý muốn.</p></div></div><em>{permissions.length} quyền hệ thống</em></div>
    <div className={styles.roleCards}>{roles.map(role=><article key={role.id} data-role={role.code}><header><span><Shield size={18}/></span><div><strong>{role.name}</strong><small>{role.code}</small></div><em>{role.member_count} người</em></header><p>{role.description||roleDescriptions[role.code]||'Vai trò truy cập hệ thống'}</p><footer><strong>{role.permissions.length} quyền được cấp</strong><div>{role.permissions.slice(0,4).map(code=><span key={code}>{permissionName.get(code)||code}</span>)}{role.permissions.length>4&&<span>+{role.permissions.length-4}</span>}</div></footer></article>)}</div>
    <section className={styles.matrix}><header><div><strong>Ma trận quyền chi tiết</strong><span>Đối chiếu quyền hiệu lực của từng vai trò</span></div><Shield size={18}/></header><div className={styles.matrixScroll}><table><thead><tr><th>Nhóm quyền</th>{roles.map(role=><th key={role.id}>{role.name}</th>)}</tr></thead><tbody>{permissionGroups.map(group=><tr key={group.name}><td><strong>{group.name}</strong><div>{permissions.filter(permission=>group.prefixes.some(prefix=>permission.code.startsWith(prefix))).map(permission=><span key={permission.code} title={permission.code}>{permission.name}</span>)}</div></td>{roles.map(role=><td key={role.id}><div>{permissions.filter(permission=>group.prefixes.some(prefix=>permission.code.startsWith(prefix))).map(permission=><i key={permission.code} data-on={role.permissions.includes(permission.code)} title={permission.code}>{role.permissions.includes(permission.code)?<Check size={12}/>:<X size={11}/>}</i>)}</div></td>)}</tr>)}</tbody></table></div></section>
    <div className={styles.roleNote}><LockKeyhole size={16}/><p><strong>Nguyên tắc an toàn:</strong> `super_admin` không xuất hiện trong danh sách gán của quản trị viên tổ chức. Schema hiện dùng vai trò dùng chung toàn hệ thống, vì vậy màn hình chỉ cho phép gán vai trò chuẩn thay vì sửa quyền toàn cục.</p></div>
  </div>;
}

function ProfileTab({user,roles,sites}:{user:UserDetail;roles:Role[];sites:Site[]}){
  const role=roles.find(item=>item.id===user.role_id);const scoped=sites.filter(site=>user.site_ids.includes(site.id));
  return <>
    <section className={styles.drawerSection}><h3>Thông tin công việc</h3><div className={styles.infoGrid}><Info icon={<Mail/>} label="Email" value={user.email}/><Info icon={<Fingerprint/>} label="Tên đăng nhập" value={user.username||'Chưa thiết lập'}/><Info icon={<Building2/>} label="Phòng ban" value={user.department||'Chưa cập nhật'}/><Info icon={<UserCog/>} label="Chức danh" value={user.job_title||'Chưa cập nhật'}/></div></section>
    <section className={styles.drawerSection}><h3>Vai trò hiệu lực</h3><div className={styles.roleSummary}><span><ShieldCheck size={20}/></span><div><strong>{user.role_name}</strong><p>{role?.description||roleDescriptions[user.role_code]||'Vai trò hệ thống'}</p></div><em>{user.permissions.length} quyền</em></div><div className={styles.permissionChips}>{user.permissions.map(item=><span key={item}>{item}</span>)}</div></section>
    <section className={styles.drawerSection}><h3>Phạm vi dữ liệu</h3>{scoped.length?<div className={styles.siteList}>{scoped.map(site=><div key={site.id}><span><MapPin size={14}/></span><div><strong>{site.name}</strong><small>{site.code}</small></div><CheckCircle2 size={15}/></div>)}</div>:<div className={styles.allSites}><Building2 size={18}/><div><strong>Toàn bộ nhà máy</strong><p>Không giới hạn phạm vi site trong tổ chức.</p></div></div>}</section>
    <section className={styles.accountMeta}><div><span>Ngày tạo</span><strong>{dateTime(user.created_at)}</strong></div><div><span>Xác minh email</span><strong data-good={user.email_verified}>{user.email_verified?'Đã xác minh':'Chưa xác minh'}</strong></div></section>
  </>;
}

function SecurityTab({user}:{user:UserDetail}){
  return <><section className={styles.securityOverview}><div><span data-tone={user.must_change_password?'amber':'green'}><KeyRound size={18}/></span><div><small>Mật khẩu</small><strong>{user.must_change_password?'Phải đổi ở lần đăng nhập tới':'Đang hoạt động'}</strong></div></div><div><span data-tone={user.failed_login_count?'red':'blue'}><Shield size={18}/></span><div><small>Đăng nhập thất bại</small><strong>{user.failed_login_count} lần</strong></div></div></section>
    <section className={styles.drawerSection}><h3>Phiên đang hoạt động <b>{user.sessions.length}</b></h3>{user.sessions.length?<div className={styles.sessionList}>{user.sessions.map(session=><article key={session.id}><span>{/mobile|android|iphone/i.test(session.user_agent||'')?<Smartphone size={17}/>:<Laptop size={17}/>}</span><div><strong>{session.device_name||(/mobile|android|iphone/i.test(session.user_agent||'')?'Thiết bị di động':'Trình duyệt máy tính')}</strong><small>{session.ip_address||'Không rõ IP'} · {relative(session.last_used_at||session.created_at)}</small></div><em>Hoạt động</em></article>)}</div>:<div className={styles.smallEmpty}><Laptop size={23}/><p>Không có phiên đăng nhập đang hoạt động.</p></div>}</section>
    <section className={styles.drawerSection}><h3>Lịch sử đăng nhập</h3>{user.login_activity.length?<div className={styles.loginList}>{user.login_activity.map(item=><div key={item.id}><span data-success={item.succeeded}>{item.succeeded?<Check size={13}/>:<X size={13}/>}</span><div><strong>{item.succeeded?'Đăng nhập thành công':'Đăng nhập thất bại'}</strong><small>{item.ip_address||'Không rõ IP'} · {dateTime(item.attempted_at)}</small>{item.failure_reason&&<em>{item.failure_reason}</em>}</div></div>)}</div>:<div className={styles.smallEmpty}><History size={22}/><p>Chưa có lịch sử đăng nhập.</p></div>}</section>
  </>;
}

const actionLabels:Record<string,string>={'user.create':'Tạo tài khoản','user.update':'Cập nhật hồ sơ và quyền','user.status':'Đổi trạng thái tài khoản','user.password_reset':'Đặt lại mật khẩu','camera.create':'Tạo camera','camera.update':'Cập nhật camera','site.create':'Tạo nhà máy','zone.create':'Tạo khu vực'};
function ActivityTab({user}:{user:UserDetail}){return <section className={styles.activityTimeline}>{user.audit_activity.length?user.audit_activity.map(item=><article key={item.id}><span><Activity size={14}/></span><div><strong>{actionLabels[item.action]||item.action}</strong><p>{item.actor_name||'Hệ thống'} · {item.entity_type}</p><small>{dateTime(item.created_at)}</small></div></article>):<div className={styles.smallEmpty}><Activity size={24}/><p>Chưa có hoạt động quản trị được ghi nhận.</p></div>}</section>;}
function Info({icon,label,value}:{icon:ReactNode;label:string;value:string}){return <div className={styles.infoItem}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;}

function UserEditor({mode,form,roles,sites,busy,setForm,close,submit}:{mode:'create'|'edit';form:UserForm;roles:Role[];sites:Site[];busy:boolean;setForm:Dispatch<SetStateAction<UserForm>>;close:()=>void;submit:(event:FormEvent)=>void}){
  const selectedRole=roles.find(role=>role.id===form.role_id);
  function toggleSite(id:string){setForm(current=>({...current,site_ids:current.site_ids.includes(id)?current.site_ids.filter(item=>item!==id):[...current.site_ids,id]}));}
  return <div className={styles.modalBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget)close();}}><form className={styles.editorModal} onSubmit={submit}>
    <header><div><span><UserCog size={19}/></span><div><small>QUẢN TRỊ TÀI KHOẢN</small><h2>{mode==='create'?'Thêm người dùng mới':'Chỉnh sửa người dùng'}</h2></div></div><button type="button" onClick={close}><X size={18}/></button></header>
    <div className={styles.editorBody}>
      <section className={styles.formSection}><h3>Thông tin cá nhân</h3><div className={styles.formGrid}><Field label="Họ và tên *"><input required minLength={2} value={form.full_name} onChange={event=>setForm(current=>({...current,full_name:event.target.value}))} placeholder="Nguyễn Văn An"/></Field><Field label="Email *"><input required type="email" value={form.email} onChange={event=>setForm(current=>({...current,email:event.target.value}))} placeholder="an@factory-ai.org"/></Field><Field label="Tên đăng nhập"><input minLength={3} value={form.username} onChange={event=>setForm(current=>({...current,username:event.target.value}))} placeholder="nguyenvanan"/></Field><Field label="Số điện thoại"><input value={form.phone} onChange={event=>setForm(current=>({...current,phone:event.target.value}))} placeholder="0901 234 567"/></Field><Field label="Phòng ban"><input value={form.department} onChange={event=>setForm(current=>({...current,department:event.target.value}))} placeholder="An toàn nhà máy"/></Field><Field label="Chức danh"><input value={form.job_title} onChange={event=>setForm(current=>({...current,job_title:event.target.value}))} placeholder="Nhân viên giám sát"/></Field></div></section>
      {mode==='create'&&<section className={styles.formSection}><h3>Thiết lập đăng nhập</h3><div className={styles.formGrid}><Field label="Mật khẩu tạm *"><input required minLength={8} type="password" autoComplete="new-password" value={form.temporary_password} onChange={event=>setForm(current=>({...current,temporary_password:event.target.value}))} placeholder="Tối thiểu 8 ký tự"/></Field><Field label="Trạng thái ban đầu"><select value={form.status} onChange={event=>setForm(current=>({...current,status:event.target.value as UserStatus}))}><option value="active">Kích hoạt ngay</option><option value="pending">Chờ kích hoạt</option><option value="disabled">Vô hiệu hóa</option></select></Field></div><div className={styles.formHint}><KeyRound size={15}/><p>Người dùng phải đổi mật khẩu tạm sau khi đăng nhập. Mật khẩu được PostgreSQL băm bằng bcrypt và không lưu dạng văn bản.</p></div></section>}
      <section className={styles.formSection}><h3>Vai trò trong tổ chức *</h3><div className={styles.roleOptions}>{roles.map(role=><label key={role.id} data-selected={form.role_id===role.id}><input type="radio" name="role" required checked={form.role_id===role.id} onChange={()=>setForm(current=>({...current,role_id:role.id}))}/><span><Shield size={16}/></span><div><strong>{role.name}</strong><small>{role.description||roleDescriptions[role.code]||role.code}</small></div><em>{role.permissions.length} quyền</em></label>)}</div>{selectedRole&&<div className={styles.selectedPermissions}><span>Quyền hiệu lực</span><div>{selectedRole.permissions.map(code=><i key={code}>{code}</i>)}</div></div>}</section>
      <section className={styles.formSection}><div className={styles.sectionHeading}><div><h3>Phạm vi nhà máy</h3><p>Không chọn site nghĩa là được truy cập toàn bộ site trong tổ chức.</p></div>{form.site_ids.length>0&&<button type="button" onClick={()=>setForm(current=>({...current,site_ids:[]}))}>Chọn toàn bộ</button>}</div>{sites.length?<div className={styles.siteOptions}>{sites.map(site=><label key={site.id} data-selected={form.site_ids.includes(site.id)}><input type="checkbox" checked={form.site_ids.includes(site.id)} onChange={()=>toggleSite(site.id)}/><span><Building2 size={15}/></span><div><strong>{site.name}</strong><small>{site.code}</small></div><Check size={15}/></label>)}</div>:<div className={styles.noSites}><Building2 size={18}/><span>Chưa có nhà máy; người dùng sẽ có phạm vi toàn tổ chức.</span></div>}</section>
    </div>
    <footer><button type="button" className={styles.cancelButton} onClick={close}>Hủy</button><button type="submit" className={styles.primaryButton} disabled={busy||!form.role_id}>{busy?<LoaderCircle size={16} className={styles.spin}/>:<CheckCircle2 size={16}/>} {mode==='create'?'Tạo tài khoản':'Lưu thay đổi'}</button></footer>
  </form></div>;
}

function ConfirmStatus({user,status,busy,close,confirm}:{user:ManagedUser;status:UserStatus;busy:boolean;close:()=>void;confirm:()=>void}){
  const locking=status!=='active';return <div className={styles.modalBackdrop}><div className={styles.confirmModal}><header><span data-danger={locking}>{locking?<Lock size={21}/>:<UserCheck size={21}/>}</span><div><h2>{locking?'Khóa tài khoản?':'Kích hoạt lại tài khoản?'}</h2><p>{user.full_name} · {user.email}</p></div></header><div className={styles.confirmBody}>{locking?<><p>Người dùng sẽ không thể đăng nhập và tất cả phiên hiện tại sẽ bị thu hồi ngay.</p><div><AlertTriangle size={15}/> Hành động được ghi vào nhật ký kiểm toán.</div></>:<p>Tài khoản sẽ có thể đăng nhập lại với vai trò và phạm vi site hiện tại.</p>}</div><footer><button className={styles.cancelButton} onClick={close}>Hủy</button><button className={locking?styles.dangerButton:styles.primaryButton} onClick={confirm} disabled={busy}>{busy?<LoaderCircle size={15} className={styles.spin}/>:locking?<Lock size={15}/>:<UserCheck size={15}/>} Xác nhận</button></footer></div></div>;
}

function PasswordModal({user,password,setPassword,busy,close,submit}:{user:ManagedUser;password:string;setPassword:(value:string)=>void;busy:boolean;close:()=>void;submit:(event:FormEvent)=>void}){
  return <div className={styles.modalBackdrop}><form className={styles.passwordModal} onSubmit={submit}><header><span><KeyRound size={21}/></span><div><h2>Đặt mật khẩu tạm</h2><p>{user.full_name} · {user.email}</p></div><button type="button" onClick={close}><X size={17}/></button></header><div className={styles.passwordBody}><Field label="Mật khẩu tạm mới *"><input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} placeholder="Tối thiểu 8 ký tự"/></Field><div className={styles.securityWarning}><ShieldOff size={17}/><div><strong>Các phiên cũ sẽ bị thu hồi</strong><p>Người dùng phải đăng nhập lại và đổi mật khẩu tạm ở lần truy cập tiếp theo.</p></div></div></div><footer><button type="button" className={styles.cancelButton} onClick={close}>Hủy</button><button type="submit" className={styles.primaryButton} disabled={busy||password.length<8}>{busy?<LoaderCircle size={15} className={styles.spin}/>:<KeyRound size={15}/>} Đặt mật khẩu</button></footer></form></div>;
}
function Field({label,children}:{label:string;children:ReactNode}){return <label className={styles.field}><span>{label}</span>{children}</label>;}

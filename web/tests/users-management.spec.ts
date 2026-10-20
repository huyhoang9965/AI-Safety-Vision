import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7D8AAAAASUVORK5CYII=','base64');
function managedUser(id:string,name:string,avatar:string|null,role='org_admin'){
 return{id,full_name:name,avatar_url:avatar,email:id+'@factory.test',username:id,department:'An toàn nhà máy',job_title:'Giám sát',phone:null,status:'active',email_verified:true,last_login_at:null,failed_login_count:0,locked_until:null,created_at:'2026-10-14T03:00:00Z',role_id:role,role_code:role,role_name:role==='org_admin'?'Quản trị viên':'Nhân viên camera',permissions:role==='org_admin'?['dashboard.view','user.view','user.manage']:['camera.view'],site_ids:[],site_count:0,active_sessions:1,must_change_password:false};
}
async function setup(page:Page,options:{broken?:boolean;absolute?:boolean;readonly?:boolean;actualAvatar?:string}={}){
 const users=[managedUser('u1','Vũ Huy Hoàng',options.actualAvatar||(options.absolute?'http://localhost:8000/avatars/admin.png':'/avatars/admin.png')),managedUser('u2','Nhân viên giám sát camera',null,'camera_employee')];
 const auth={id:'u1',full_name:'Vũ Huy Hoàng',email:'u1@factory.test',avatar_url:null,memberships:[{organization_id:'org-1',is_default:true,role_name:'Quản trị viên',permissions:options.readonly?['dashboard.view','user.view']:['dashboard.view','user.view','user.manage']}]};
 const state={users,broken:Boolean(options.broken),requests:[] as string[],avatars:[] as string[],delay:false,release:()=>{}};
 const pending=new Promise<void>(resolve=>{state.release=resolve;});
 await page.addInitScript(user=>localStorage.setItem('ai-safety-auth-session-v1',JSON.stringify({access_token:'test-only',refresh_token:'test-only',token_type:'bearer',expires_in:3600,user})),auth);
 await page.route('**/avatars/**',async route=>{
  state.avatars.push(route.request().url());expect(new URL(route.request().url()).origin).toBe('http://localhost:8000');
  if(options.actualAvatar){await route.continue();return;}
  if(state.broken){await route.fulfill({status:404,body:'Missing image'});return;}
  await route.fulfill({contentType:'image/png',body:png});
 });
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());state.requests.push(url.pathname);let body;
  if(url.pathname==='/api/auth/me')body=auth;
  else if(url.pathname==='/api/health')body={status:'ok',database:'connected'};
  else{
   expect(route.request().headers().authorization).toBe('Bearer test-only');
   if(url.pathname==='/api/users')body={users:state.users,roles:[{id:'org_admin',code:'org_admin',name:'Quản trị viên',description:'Quản trị tổ chức',is_system:true,permissions:['dashboard.view','user.view','user.manage'],member_count:1},{id:'camera_employee',code:'camera_employee',name:'Nhân viên camera',description:'Giám sát camera',is_system:true,permissions:['camera.view'],member_count:1}],permissions:[{id:'p1',code:'user.view',name:'Xem người dùng',description:null},{id:'p2',code:'camera.view',name:'Xem camera',description:null}],sites:[],summary:{total:2,active:2,pending:0,locked:0,disabled:0,admins:1,active_sessions:2},organization_name:'Factory AI Safety'};
   else if(url.pathname.startsWith('/api/users/')){const id=url.pathname.split('/').at(-1);if(id==='u1'&&state.delay)await pending;body={...state.users.find(user=>user.id===id),login_activity:[],audit_activity:[],sessions:[]};}
   else throw new Error('Unexpected path '+url.pathname);
  }
  await route.fulfill({json:body}).catch(()=>{});
 });
 await page.goto('/dashboard/users');await expect(page.getByRole('region',{name:'Danh sách người dùng',exact:true}).getByRole('table')).toBeVisible();return state;
}
const list=(page:Page)=>page.getByRole('region',{name:'Danh sách người dùng',exact:true});
const drawer=(page:Page)=>page.getByRole('complementary',{name:'Chi tiết người dùng',exact:true});
const avatar=(page:Page)=>list(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng',exact:true});

test('relative avatars use backend URLs, fixed dimensions and lazy loading',async({page})=>{
 const state=await setup(page);await expect(avatar(page)).toHaveAttribute('src','http://localhost:8000/avatars/admin.png');await expect(avatar(page)).toHaveAttribute('loading','lazy');
 await expect.poll(()=>avatar(page).evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
 const box=(await avatar(page).boundingBox())!;expect(box.width).toBe(36);expect(box.height).toBe(36);
 await expect(list(page).getByRole('img',{name:'Ảnh đại diện của Nhân viên giám sát camera (chữ viết tắt)',exact:true})).toHaveText('SC');
 expect(state.requests.filter(url=>url.startsWith('/api/users/'))).toHaveLength(0);await expect(drawer(page)).toHaveCount(0);
});

test('absolute avatars stay intact and the drawer uses the normalized source',async({page})=>{
 await setup(page,{absolute:true});await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();
 const image=drawer(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng',exact:true});await expect(image).toHaveAttribute('src','http://localhost:8000/avatars/admin.png');
 await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
 const box=(await image.boundingBox())!;expect(box.width).toBe(52);expect(box.height).toBe(52);await page.keyboard.press('Escape');await expect(drawer(page)).toHaveCount(0);
});

test('404 avatars fall back to initials in list and detail without broken images',async({page})=>{
 await setup(page,{broken:true});await expect(list(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng (chữ viết tắt)',exact:true})).toHaveText('HH');await expect(list(page).locator('img')).toHaveCount(0);
 await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect(drawer(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng (chữ viết tắt)',exact:true})).toHaveText('HH');await expect(drawer(page).locator('img')).toHaveCount(0);
});

test('sync refreshes changed avatar URLs in table and reopened profile',async({page})=>{
 const state=await setup(page,{broken:true});await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect(drawer(page).getByRole('img',{name:/chữ viết tắt/})).toBeVisible();
 state.broken=false;state.users[0].avatar_url='/avatars/new-avatar.png';await page.keyboard.press('Escape');await page.getByRole('button',{name:'Đồng bộ',exact:true}).click();
 await expect(avatar(page)).toHaveAttribute('src','http://localhost:8000/avatars/new-avatar.png');await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect(drawer(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng',exact:true})).toHaveAttribute('src','http://localhost:8000/avatars/new-avatar.png');
});

test('slow old profile cannot overwrite a newly selected account or avatar',async({page})=>{
 const state=await setup(page);state.delay=true;await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect.poll(()=>state.requests.includes('/api/users/u1')).toBe(true);
 await page.getByRole('button',{name:'Xem hồ sơ Nhân viên giám sát camera',exact:true}).click();await expect(drawer(page).getByRole('heading',{name:'Nhân viên giám sát camera',exact:true})).toBeVisible();state.release();
 await expect(drawer(page).getByRole('heading',{name:'Nhân viên giám sát camera',exact:true})).toBeVisible();await expect(drawer(page).getByRole('img',{name:'Ảnh đại diện của Nhân viên giám sát camera (chữ viết tắt)',exact:true})).toHaveText('SC');
});

test('search and role filtering preserve avatars and the permission matrix',async({page})=>{
 await setup(page);await page.getByRole('textbox',{name:'Tìm người dùng',exact:true}).fill('camera');await expect(list(page).locator('tbody tr')).toHaveCount(1);
 await page.getByRole('textbox',{name:'Tìm người dùng',exact:true}).fill('');await page.getByRole('combobox',{name:'Vai trò người dùng',exact:true}).selectOption('org_admin');await expect(list(page).locator('tbody tr')).toHaveCount(1);await expect(avatar(page)).toBeVisible();
 await page.getByRole('button',{name:/Vai trò & ma trận quyền/}).click();await expect(page.getByText('Ma trận quyền chi tiết',{exact:true})).toBeVisible();
});

test('read-only access hides management actions while allowing keyboard-opened profiles',async({page})=>{
 await setup(page,{readonly:true});await expect(page.getByRole('button',{name:'Thêm người dùng',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).focus();await page.keyboard.press('Enter');await expect(drawer(page)).toBeVisible();await expect(drawer(page).getByRole('button',{name:'Sửa',exact:true})).toHaveCount(0);
});

test('mobile preserves avatar size and keeps profiles inside the viewport',async({page})=>{
 await page.setViewportSize({width:390,height:844});await setup(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect(drawer(page)).toBeVisible();await expect.poll(async()=>{const box=await drawer(page).boundingBox();return Boolean(box&&box.x>=0&&box.x+box.width<=390);}).toBe(true);
 await page.getByRole('button',{name:'Đóng hồ sơ người dùng',exact:true}).click();await expect(drawer(page)).toHaveCount(0);
});

test('uploaded avatars from the running backend decode in list and profile',async({page,request})=>{
 const directory=path.resolve('..','storage','avatars');const file=fs.existsSync(directory)?fs.readdirSync(directory).find(name=>name.endsWith('.png')):undefined;test.skip(!file,'Local uploaded avatar is required.');
 const response=await request.get('http://localhost:8000/avatars/'+file).catch(()=>null);test.skip(!response?.ok(),'Local avatar backend is required.');await setup(page,{actualAvatar:'/avatars/'+file});await expect.poll(()=>avatar(page).evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);await list(page).screenshot({path:'../storage/outputs/users-avatars-fixed.png'});
 await page.getByRole('button',{name:'Xem hồ sơ Vũ Huy Hoàng',exact:true}).click();await expect.poll(()=>drawer(page).getByRole('img',{name:'Ảnh đại diện của Vũ Huy Hoàng',exact:true}).evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
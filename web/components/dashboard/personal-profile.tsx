'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { AlertCircle, Building2, Camera, Check, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Mail, Save, ShieldCheck, Trash2, Upload, UserRound, X } from 'lucide-react';
import { AuthApiError, resolveAvatarUrl, userRole, type ApiUser } from '@/lib/auth';
import { changeMyPassword, profileFields, saveMyProfile, type ProfileFields } from '@/lib/profile';
import { useDashboardAccount } from './dashboard-account';
import styles from './personal-profile.module.css';

type FieldErrors = Partial<Record<keyof ProfileFields, string>>;
type PasswordFields = { current: string; next: string; confirmation: string };
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;

function today() {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function dateLabel(value?: string | null) {
  if (!value) return 'Chưa có thông tin';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa có thông tin' : date.toLocaleDateString('vi-VN');
}

function validate(fields: ProfileFields): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.full_name.trim().length < 2) errors.full_name = 'Vui lòng nhập họ tên từ 2 ký tự.';
  if (fields.full_name.trim().length > 150) errors.full_name = 'Họ tên tối đa 150 ký tự.';
  if (fields.username.trim() && (fields.username.trim().length < 3 || fields.username.trim().length > 60)) errors.username = 'Tên tài khoản cần từ 3 đến 60 ký tự.';
  if (fields.phone.trim() && (!/^\+?[\d\s().-]+$/.test(fields.phone.trim()) || fields.phone.replace(/\D/g, '').length < 9 || fields.phone.replace(/\D/g, '').length > 15)) errors.phone = 'Số điện thoại cần từ 9 đến 15 chữ số.';
  if (fields.birthday && fields.birthday > today()) errors.birthday = 'Ngày sinh không được ở tương lai.';
  if (fields.bio.length > 200) errors.bio = 'Giới thiệu tối đa 200 ký tự.';
  return errors;
}

function Field({ id, label, hint, error, required, children }: { id: string; label: string; hint?: string; error?: string; required?: boolean; children: ReactNode }) {
  return <div className={styles.field}>
    <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children}
    {(error || hint) && <p id={`${id}-help`} className={error ? styles.fieldError : styles.hint}>{error || hint}</p>}
  </div>;
}

function ProfileAvatar({ name, url }: { name: string; url?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={styles.avatar}>{url && failed !== url
    ? <img src={url} alt={`Ảnh đại diện của ${name}`} onError={() => setFailed(url)} />
    : <span aria-label={`Ảnh đại diện: ${name}`}>{name.trim().split(/\s+/).filter(Boolean).slice(-2).map(part => part[0]).join('').toUpperCase() || 'CN'}</span>}
  </span>;
}

export default function PersonalProfile() {
  const user = useDashboardAccount();
  return <ProfileEditor key={user.id} user={user} />;
}

function ProfileEditor({ user }: { user: ApiUser }) {
  const router = useRouter();
  const id = useId();
  const [savedUser, setSavedUser] = useState(user);
  const [fields, setFields] = useState<ProfileFields>(() => profileFields(user));
  const [tab, setTab] = useState<'personal' | 'security'>('personal');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [readingAvatar, setReadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState<PasswordFields>({ current: '', next: '', confirmation: '' });
  const [passwordErrors, setPasswordErrors] = useState<Partial<Record<keyof PasswordFields, string>>>({});
  const [visible, setVisible] = useState({ current: false, next: false, confirmation: false });
  const [changingPassword, setChangingPassword] = useState(false);
  const [dateMaximum, setDateMaximum] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const passwordFormRef = useRef<HTMLFormElement>(null);
  const uploadSequence = useRef(0);
  const requestLock = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const saved = profileFields(savedUser);
  const dirty = avatarData !== null || removeAvatar || (Object.keys(fields) as Array<keyof ProfileFields>).some(key => fields[key] !== saved[key]);
  const passwordDirty = Boolean(password.current || password.next || password.confirmation);
  const busy = saving || readingAvatar || changingPassword;
  const previewUrl = removeAvatar ? null : avatarData || resolveAvatarUrl(savedUser.avatar_url);
  const membership = user.memberships.find(item => item.is_default) || user.memberships[0];

  useEffect(() => { setDateMaximum(today()); return () => { uploadSequence.current += 1; }; }, []);
  useEffect(() => {
    if (!dirty && !passwordDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, passwordDirty]);

  function updateField<K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) {
    setFields(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: undefined }));
    setNotice(null);
  }
  const attributes = (key: keyof ProfileFields) => ({
    id: `${id}-${key}`, name: key, value: fields[key],
    'aria-invalid': Boolean(errors[key]), 'aria-describedby': `${id}-${key}-help`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => updateField(key, event.target.value as ProfileFields[typeof key]),
  });

  async function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const sequence = ++uploadSequence.current;
    setAvatarError(''); setNotice(null); setReadingAvatar(true);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.');
      if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Ảnh phải có dung lượng lớn hơn 0 và không quá 5 MB.');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Không đọc được ảnh.'));
        reader.onerror = reader.onabort = () => reject(new Error('Không đọc được ảnh.'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth && image.naturalHeight && image.naturalWidth * image.naturalHeight <= 16_000_000 ? resolve() : reject(new Error('Ảnh không hợp lệ hoặc có kích thước quá lớn.'));
        image.onerror = () => reject(new Error('Tệp này không phải ảnh hợp lệ.'));
        image.src = data;
      });
      if (sequence === uploadSequence.current) { setAvatarData(data); setRemoveAvatar(false); }
    } catch (error) {
      if (sequence === uploadSequence.current) setAvatarError(error instanceof Error ? error.message : 'Không thể chọn ảnh này.');
    } finally {
      if (sequence === uploadSequence.current) setReadingAvatar(false);
    }
  }

  function discard() {
    uploadSequence.current += 1;
    setFields(profileFields(savedUser)); setAvatarData(null); setRemoveAvatar(false); setAvatarError(''); setErrors({});
    setNotice({ kind: 'info', text: 'Đã khôi phục thông tin ở lần lưu gần nhất.' });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || requestLock.current || !dirty) return;
    const nextErrors = validate(fields); setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setNotice({ kind: 'error', text: 'Vui lòng kiểm tra các thông tin được đánh dấu.' });
      formRef.current?.querySelector<HTMLElement>(`[name="${Object.keys(nextErrors)[0]}"]`)?.focus();
      return;
    }
    requestLock.current = true; setSaving(true); setNotice(null);
    try {
      const result = await saveMyProfile(fields, avatarData, removeAvatar);
      setSavedUser(result); setFields(profileFields(result)); setAvatarData(null); setRemoveAvatar(false);
      setNotice({ kind: 'success', text: 'Đã cập nhật hồ sơ của bạn. Thông tin được lưu vào tài khoản.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof AuthApiError ? error.message : 'Không thể kết nối máy chủ. Thông tin bạn nhập vẫn được giữ lại.' });
      if (error instanceof AuthApiError && error.status === 401) router.replace('/');
    } finally { requestLock.current = false; setSaving(false); }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || requestLock.current) return;
    const nextErrors: Partial<Record<keyof PasswordFields, string>> = {};
    if (!password.current) nextErrors.current = 'Vui lòng nhập mật khẩu hiện tại.';
    if (password.next.length < 8) nextErrors.next = 'Mật khẩu mới cần ít nhất 8 ký tự.';
    else if (new TextEncoder().encode(password.next).length > 72) nextErrors.next = 'Mật khẩu mới quá dài. Vui lòng chọn mật khẩu ngắn hơn.';
    else if (password.next === password.current) nextErrors.next = 'Mật khẩu mới phải khác mật khẩu hiện tại.';
    if (!password.confirmation || password.confirmation !== password.next) nextErrors.confirmation = 'Mật khẩu nhập lại chưa khớp.';
    setPasswordErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      passwordFormRef.current?.querySelector<HTMLElement>(`[name="${Object.keys(nextErrors)[0]}"]`)?.focus();
      return;
    }
    requestLock.current = true; setChangingPassword(true); setNotice(null);
    try {
      const result = await changeMyPassword(password.current, password.next);
      setSavedUser(result);
      setPassword({ current: '', next: '', confirmation: '' }); setVisible({ current: false, next: false, confirmation: false });
      setNotice({ kind: 'success', text: 'Đã đổi mật khẩu thành công. Phiên đăng nhập hiện tại đã được cập nhật.' });
    } catch (error) {
      setPassword({ current: '', next: '', confirmation: '' }); setVisible({ current: false, next: false, confirmation: false });
      setNotice({ kind: 'error', text: error instanceof AuthApiError ? error.message : 'Không thể kết nối máy chủ. Vui lòng thử lại.' });
      if (error instanceof AuthApiError && error.status === 401) router.replace('/');
    } finally { requestLock.current = false; setChangingPassword(false); }
  }

  return <div className={styles.page}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>TÀI KHOẢN CÁ NHÂN</span><h1>Hồ sơ của tôi</h1><p>Quản lý thông tin và bảo mật của tài khoản đang đăng nhập.</p></div><span className={styles.accountBadge}><ShieldCheck size={15} />{userRole(user)}</span></header>

    <section className={styles.hero} aria-label="Tổng quan hồ sơ">
      <div className={styles.heroIdentity}><div className={styles.avatarWrap}><ProfileAvatar name={savedUser.full_name} url={previewUrl} /><button type="button" className={styles.cameraButton} disabled={busy} aria-label="Thay ảnh đại diện" onClick={() => fileInput.current?.click()}><Camera size={15} /></button></div><div className={styles.heroText}><span>HỒ SƠ CÁ NHÂN</span><h2>{savedUser.full_name}</h2><p><Mail size={13} />{savedUser.email}</p><div className={styles.heroBadges}><span><UserRound size={12} />{userRole(user)}</span>{user.email_verified && <span className={styles.verifiedBadge}><CheckCircle2 size={12} />Email đã xác thực</span>}</div></div></div>
      <div className={styles.organization}><span><Building2 size={16} />Không gian làm việc</span><strong>{membership?.organization_name || 'Chưa được gán tổ chức'}</strong><small>{savedUser.department || 'Chưa cập nhật bộ phận'}</small></div>
    </section>
    <input ref={fileInput} className={styles.hiddenInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Tệp ảnh đại diện" onChange={selectAvatar} disabled={busy} />

    <div className={styles.layout}>
      <aside className={styles.accountCard}><div className={styles.cardTitle}><ShieldCheck size={18} /><h2>Thông tin tài khoản</h2></div><dl><div><dt>Email đăng nhập</dt><dd>{savedUser.email}</dd></div><div><dt>Vai trò</dt><dd>{userRole(user)}</dd></div><div><dt>Mã tài khoản</dt><dd className={styles.accountId}>{user.id}</dd></div><div><dt>Ngày tạo tài khoản</dt><dd>{dateLabel(savedUser.created_at)}</dd></div></dl><p className={styles.accountHint}><LockKeyhole size={15} /><span>Email đăng nhập và quyền truy cập do quản trị viên quản lý.</span></p></aside>

      <div className={styles.editor}>
        <div className={styles.noticeRegion} aria-live="polite" aria-atomic="true">{notice && <div className={`${styles.notice} ${styles[notice.kind]}`}><span>{notice.kind === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}</span><p>{notice.text}</p><button type="button" onClick={() => setNotice(null)} aria-label="Đóng thông báo"><X size={16} /></button></div>}</div>
        <div className={styles.panel}>
          <div className={styles.tabs} role="tablist" aria-label="Cài đặt hồ sơ">{([{ key: 'personal', label: 'Thông tin cá nhân', icon: UserRound }, { key: 'security', label: 'Bảo mật & mật khẩu', icon: ShieldCheck }] as const).map((item, index) => <button key={item.key} ref={node => { tabRefs.current[index] = node; }} type="button" role="tab" id={`${id}-tab-${item.key}`} aria-selected={tab === item.key} aria-controls={`${id}-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} className={tab === item.key ? styles.activeTab : ''} disabled={busy} onClick={() => { setTab(item.key); setNotice(null); }} onKeyDown={event => { let next: number; if (['ArrowLeft', 'ArrowRight'].includes(event.key)) next = 1 - index; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = 1; else return; event.preventDefault(); if (busy) return; setTab(next === 0 ? 'personal' : 'security'); setNotice(null); tabRefs.current[next]?.focus(); }}><item.icon size={16} />{item.label}</button>)}</div>

          <section role="tabpanel" id={`${id}-panel-personal`} aria-labelledby={`${id}-tab-personal`} hidden={tab !== 'personal'} tabIndex={0}>
            <form ref={formRef} onSubmit={save} noValidate aria-busy={saving}>
              <div className={styles.panelIntro}><h2>Thông tin cá nhân</h2><p>Thông tin mới sẽ được lưu vào hồ sơ của bạn khi nhấn “Lưu thay đổi”.</p></div>
              <div className={styles.avatarEditor}><ProfileAvatar name={fields.full_name} url={previewUrl} /><div><h3>Ảnh đại diện</h3><p>JPG, PNG hoặc WebP · Tối đa 5 MB</p><div className={styles.avatarActions}><button type="button" className={styles.secondaryButton} onClick={() => fileInput.current?.click()} disabled={busy}>{readingAvatar ? <LoaderCircle size={14} className={styles.spin} /> : <Upload size={14} />}{readingAvatar ? 'Đang đọc ảnh…' : 'Chọn ảnh mới'}</button>{previewUrl && <button type="button" className={styles.removeButton} disabled={busy} onClick={() => { setAvatarData(null); setRemoveAvatar(Boolean(savedUser.avatar_url)); setAvatarError(''); setNotice(null); }}><Trash2 size={14} />Xóa ảnh</button>}</div>{avatarError && <p className={styles.fieldError} role="alert">{avatarError}</p>}</div></div>
              <fieldset className={styles.fields} disabled={busy}><legend className={styles.srOnly}>Thông tin có thể chỉnh sửa</legend>
                <div className={styles.sectionTitle}><h3>Thông tin cơ bản</h3><span>* Bắt buộc</span></div>
                <div className={styles.fieldGrid}>
                  <Field id={`${id}-full_name`} label="Họ và tên" required error={errors.full_name} hint="Tên hiển thị trong dashboard."><input {...attributes('full_name')} type="text" autoComplete="name" maxLength={150} required placeholder="Nhập họ và tên" /></Field>
                  <Field id={`${id}-username`} label="Tên tài khoản" error={errors.username} hint="Không bắt buộc. Từ 3 đến 60 ký tự."><input {...attributes('username')} type="text" autoComplete="username" maxLength={60} placeholder="Nhập tên tài khoản" /></Field>
                  <Field id={`${id}-phone`} label="Số điện thoại" error={errors.phone} hint="Không bắt buộc."><input {...attributes('phone')} type="tel" autoComplete="tel" maxLength={30} placeholder="Nhập số điện thoại" /></Field>
                  <Field id={`${id}-birthday`} label="Ngày sinh" error={errors.birthday} hint="Không bắt buộc."><input {...attributes('birthday')} type="date" autoComplete="bday" max={dateMaximum || undefined} /></Field>
                  <Field id={`${id}-gender`} label="Giới tính" error={errors.gender} hint="Bạn có thể chọn không cung cấp."><select {...attributes('gender')}><option value="">Chọn giới tính</option><option value="male">Nam</option><option value="female">Nữ</option><option value="other">Khác</option><option value="undisclosed">Không muốn cung cấp</option></select></Field>
                </div>
                <div className={`${styles.sectionTitle} ${styles.divider}`}><h3>Công việc & giới thiệu</h3><span>Không bắt buộc</span></div>
                <div className={styles.fieldGrid}>
                  <Field id={`${id}-department`} label="Bộ phận" error={errors.department} hint="Tên bộ phận đang làm việc."><input {...attributes('department')} type="text" autoComplete="organization" maxLength={150} placeholder="Nhập bộ phận" /></Field>
                  <Field id={`${id}-job_title`} label="Chức danh" error={errors.job_title} hint="Thông tin mô tả, không thay đổi quyền truy cập."><input {...attributes('job_title')} type="text" autoComplete="organization-title" maxLength={150} placeholder="Nhập chức danh" /></Field>
                  <div className={styles.fullWidth}><Field id={`${id}-bio`} label="Giới thiệu ngắn" error={errors.bio} hint={`${fields.bio.length}/200 ký tự`}><textarea {...attributes('bio')} rows={3} maxLength={200} placeholder="Viết một vài dòng giới thiệu về bạn…" /></Field></div>
                </div>
              </fieldset>
              <footer className={styles.formFooter}><p className={dirty ? styles.unsaved : ''}><i />{dirty ? 'Có thay đổi chưa lưu' : 'Không có thay đổi chưa lưu'}</p><div><button type="button" className={styles.secondaryButton} disabled={!dirty || busy} onClick={discard}>Hủy thay đổi</button><button type="submit" className={styles.primaryButton} disabled={!dirty || busy}>{saving ? <LoaderCircle size={15} className={styles.spin} /> : <Save size={15} />}{saving ? 'Đang lưu…' : 'Lưu thay đổi'}</button></div></footer>
            </form>
          </section>

          <section role="tabpanel" id={`${id}-panel-security`} aria-labelledby={`${id}-tab-security`} hidden={tab !== 'security'} tabIndex={0}>
            <form ref={passwordFormRef} onSubmit={submitPassword} noValidate aria-busy={changingPassword}>
              <div className={styles.panelIntro}><h2>Đổi mật khẩu</h2><p>Cập nhật mật khẩu đăng nhập của tài khoản này.</p></div>
              <div className={styles.securitySummary}><span><KeyRound size={23} /></span><div><h3>Mật khẩu đăng nhập</h3><p>Lần cập nhật gần nhất: {dateLabel(savedUser.password_changed_at)}</p></div></div>
              <fieldset className={`${styles.fields} ${styles.passwordFields}`} disabled={busy}><legend className={styles.srOnly}>Các trường đổi mật khẩu</legend>
                {([{ key: 'current', label: 'Mật khẩu hiện tại', hint: 'Nhập mật khẩu bạn đang sử dụng.', autoComplete: 'current-password' }, { key: 'next', label: 'Mật khẩu mới', hint: 'Ít nhất 8 ký tự và khác mật khẩu hiện tại.', autoComplete: 'new-password' }, { key: 'confirmation', label: 'Nhập lại mật khẩu mới', hint: 'Nhập lại mật khẩu mới để xác nhận.', autoComplete: 'new-password' }] as const).map(item => <Field key={item.key} id={`${id}-password-${item.key}`} label={item.label} hint={item.hint} error={passwordErrors[item.key]} required><div className={styles.passwordInput}><input id={`${id}-password-${item.key}`} name={item.key} value={password[item.key]} type={visible[item.key] ? 'text' : 'password'} autoComplete={item.autoComplete} maxLength={128} required placeholder={item.label} aria-invalid={Boolean(passwordErrors[item.key])} aria-describedby={`${id}-password-${item.key}-help`} onChange={event => { const value = event.target.value; setPassword(previous => ({ ...previous, [item.key]: value })); setPasswordErrors({}); setNotice(null); }} /><button type="button" aria-label={`${visible[item.key] ? 'Ẩn' : 'Hiện'} ${item.label.toLowerCase()}`} aria-pressed={visible[item.key]} onClick={() => setVisible(previous => ({ ...previous, [item.key]: !previous[item.key] }))}>{visible[item.key] ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></Field>)}
                <div className={styles.passwordChecks}><p data-valid={password.next.length >= 8}><Check size={14} />Ít nhất 8 ký tự</p><p data-valid={Boolean(password.next && password.next !== password.current)}><Check size={14} />Khác mật khẩu hiện tại</p><p data-valid={Boolean(password.confirmation && password.confirmation === password.next)}><Check size={14} />Mật khẩu xác nhận trùng khớp</p></div>
                <p className={styles.securityNote}><ShieldCheck size={16} />Bạn tiếp tục sử dụng tài khoản trên thiết bị này sau khi đổi mật khẩu. Các phiên đăng nhập cũ sẽ cần đăng nhập lại khi hết hạn.</p>
              </fieldset>
              <footer className={styles.formFooter}><p><LockKeyhole size={13} />Xác minh mật khẩu hiện tại trước khi đổi</p><div><button type="button" className={styles.secondaryButton} disabled={!passwordDirty || busy} onClick={() => { setPassword({ current: '', next: '', confirmation: '' }); setPasswordErrors({}); setVisible({ current: false, next: false, confirmation: false }); setNotice(null); }}>Xóa nội dung</button><button type="submit" className={styles.primaryButton} disabled={!passwordDirty || busy}>{changingPassword ? <LoaderCircle size={15} className={styles.spin} /> : <KeyRound size={15} />}{changingPassword ? 'Đang cập nhật…' : 'Đổi mật khẩu'}</button></div></footer>
            </form>
          </section>
        </div>
      </div>
    </div>
  </div>;
}

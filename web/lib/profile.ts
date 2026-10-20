import { AuthApiError, authenticatedFetch, replaceCurrentAuthSession, updateStoredUser, type ApiUser, type AuthSession } from './auth';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export type ProfileFields = {
  full_name: string;
  username: string;
  phone: string;
  department: string;
  job_title: string;
  birthday: string;
  gender: '' | 'male' | 'female' | 'other' | 'undisclosed';
  bio: string;
};

export function profileFields(user: ApiUser): ProfileFields {
  return { full_name: user.full_name, username: user.username || '', phone: user.phone || '',
    department: user.department || '', job_title: user.job_title || '', birthday: user.birthday || '',
    gender: user.gender || '', bio: user.bio || '' };
}

async function profileRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await authenticatedFetch(API_BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.detail === 'string' ? payload.detail
      : response.status === 422 ? 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại các trường đã nhập.'
      : 'Không thể cập nhật tài khoản. Vui lòng thử lại.';
    throw new AuthApiError(message, response.status);
  }
  return payload as T;
}

export async function saveMyProfile(fields: ProfileFields, avatarData: string | null, removeAvatar: boolean): Promise<ApiUser> {
  const normalized = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
  const user = await profileRequest<ApiUser>('/api/auth/me', {
    ...normalized,
    username: normalized.username || null, phone: normalized.phone || null,
    department: normalized.department || null, job_title: normalized.job_title || null,
    birthday: normalized.birthday || null, gender: normalized.gender || null,
    ...(avatarData !== null ? { avatar_data: avatarData } : {}), remove_avatar: removeAvatar,
  });
  updateStoredUser(user);
  return user;
}

export async function changeMyPassword(currentPassword: string, newPassword: string): Promise<ApiUser> {
  const session = await profileRequest<AuthSession>('/api/auth/me/password', {
    current_password: currentPassword, new_password: newPassword,
  });
  replaceCurrentAuthSession(session);
  return session.user;
}

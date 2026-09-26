const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const AUTH_STORAGE_KEY = 'ai-safety-auth-session-v1';

export type ApiMembership = {
  organization_id: string;
  organization_code: string;
  organization_name: string;
  role_code: string;
  role_name: string;
  is_default: boolean;
  permissions: string[];
};

export type ApiUser = {
  id: string;
  email: string;
  username: string | null;
  full_name: string;
  department: string | null;
  job_title: string | null;
  phone: string | null;
  avatar_url: string | null;
  status: string;
  email_verified: boolean;
  memberships: ApiMembership[];
};

export type AuthSession = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: ApiUser;
};

type RegisterPayload = {
  email: string;
  password: string;
  full_name: string;
  department?: string;
  job_title?: string;
};

type RegisterResponse = {
  user: ApiUser;
  message: string;
};

export class AuthApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new AuthApiError('Không thể kết nối backend. Hãy kiểm tra FastAPI đang chạy ở cổng 8000.', 0);
  }

  const payload = response.status === 204
    ? null
    : await response.json().catch(() => null) as { detail?: string } | null;

  if (!response.ok) {
    throw new AuthApiError(payload?.detail || 'Yêu cầu xác thực thất bại.', response.status);
  }
  return payload as T;
}

export function userRole(user: ApiUser): string {
  const defaultMembership = user.memberships.find(item => item.is_default) || user.memberships[0];
  return defaultMembership?.role_name || user.job_title || user.department || 'Người dùng';
}

export function userPermissions(user: ApiUser): Set<string> {
  return new Set(user.memberships.flatMap(membership => membership.permissions));
}

export function hasPermission(user: ApiUser, permission: string): boolean {
  return userPermissions(user).has(permission);
}

export function defaultAppPath(user: ApiUser): string | null {
  const permissions = userPermissions(user);
  if (permissions.has('dashboard.view')) return '/dashboard';
  if (permissions.has('camera.view')) return '/dashboard/live';
  return null;
}

export async function registerAccount(payload: RegisterPayload): Promise<RegisterResponse> {
  return apiRequest<RegisterResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loginAccount(email: string, password: string): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function getCurrentUser(accessToken: string): Promise<ApiUser> {
  return apiRequest<ApiUser>('/api/auth/me', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

export async function refreshAccount(refreshToken: string): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export function saveAuthSession(session: AuthSession, remember: boolean): void {
  clearAuthSession();
  const storage = remember ? window.localStorage : window.sessionStorage;
  storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function readAuthSession(): { session: AuthSession; remember: boolean } | null {
  for (const [storage, remember] of [
    [window.localStorage, true],
    [window.sessionStorage, false],
  ] as const) {
    const raw = storage.getItem(AUTH_STORAGE_KEY);
    if (!raw) continue;
    try {
      const session = JSON.parse(raw) as AuthSession;
      if (session.access_token && session.refresh_token && session.user?.id) {
        return { session, remember };
      }
    } catch {
      storage.removeItem(AUTH_STORAGE_KEY);
    }
  }
  return null;
}

export function clearAuthSession(): void {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

export async function restoreAuthSession(): Promise<AuthSession | null> {
  const stored = readAuthSession();
  if (!stored) return null;

  try {
    const user = await getCurrentUser(stored.session.access_token);
    const session = { ...stored.session, user };
    saveAuthSession(session, stored.remember);
    return session;
  } catch (error) {
    if (!(error instanceof AuthApiError) || error.status !== 401) {
      clearAuthSession();
      return null;
    }
  }

  try {
    const refreshed = await refreshAccount(stored.session.refresh_token);
    saveAuthSession(refreshed, stored.remember);
    return refreshed;
  } catch {
    clearAuthSession();
    return null;
  }
}

export async function logoutAccount(): Promise<void> {
  const stored = readAuthSession();
  try {
    if (stored) {
      await apiRequest<void>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: stored.session.refresh_token }),
      });
    }
  } finally {
    clearAuthSession();
  }
}

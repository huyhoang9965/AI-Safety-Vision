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
  birthday?: string | null;
  gender?: 'male' | 'female' | 'other' | 'undisclosed' | null;
  bio?: string;
  created_at?: string | null;
  password_changed_at?: string | null;
};

export type AuthSession = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  access_expires_at?: number;
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

async function apiRequest<T>(path: string, init?: RequestInit, request = fetch): Promise<T> {
  let response: Response;
  try {
    response = await request(API_BASE + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof AuthApiError) throw error;
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
  }, authenticatedFetch);
}

export async function refreshAccount(refreshToken: string): Promise<AuthSession> {
  return apiRequest<AuthSession>('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export function saveAuthSession(session: AuthSession, remember: boolean): void {
  const storage = remember ? window.localStorage : window.sessionStorage;
  storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    ...session,
    access_expires_at: tokenExpiry(session) ?? Date.now() + session.expires_in * 1000,
  }));
  (remember ? window.sessionStorage : window.localStorage).removeItem(AUTH_STORAGE_KEY);
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

export const AUTH_USER_UPDATED_EVENT = 'safety-auth-user-updated';

export function updateStoredUser(user: ApiUser): void {
  const stored = readAuthSession();
  if (!stored || stored.session.user.id !== user.id) {
    throw new AuthApiError('Phiên đăng nhập đã thay đổi. Vui lòng đăng nhập lại.', 401);
  }
  saveAuthSession({ ...stored.session, user }, stored.remember);
  window.dispatchEvent(new Event(AUTH_USER_UPDATED_EVENT));
}

export function replaceCurrentAuthSession(session: AuthSession): void {
  const stored = readAuthSession();
  if (!stored || stored.session.user.id !== session.user.id) {
    throw new AuthApiError('Phiên đăng nhập đã thay đổi. Vui lòng đăng nhập lại.', 401);
  }
  saveAuthSession(session, stored.remember);
  window.dispatchEvent(new Event(AUTH_USER_UPDATED_EVENT));
}

export function resolveAvatarUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') && !url.startsWith('//') ? API_BASE + url : url;
}

function tokenExpiry(session: AuthSession): number | null {
  // Only a scheduling hint; the backend still verifies the signature and expiry.
  try {
    const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch { /* Legacy stored sessions can use the expiry saved at login. */ }
  return typeof session.access_expires_at === 'number' ? session.access_expires_at : null;
}

let refreshInFlight: Promise<AuthSession | null> | null = null;

async function renewAuthSession(expected: AuthSession): Promise<AuthSession | null> {
  if (refreshInFlight) return refreshInFlight;
  const renew = async () => {
    const stored = readAuthSession();
    if (!stored) return null;
    // Another request or tab may already have rotated both tokens.
    if (stored.session.access_token !== expected.access_token
        || stored.session.refresh_token !== expected.refresh_token) return stored.session;
    try {
      const refreshed = await refreshAccount(stored.session.refresh_token);
      const current = readAuthSession();
      if (!current) return null; // A pending refresh must never undo logout.
      if (current.session.refresh_token !== stored.session.refresh_token) return current.session;
      saveAuthSession(refreshed, current.remember);
      return refreshed;
    } catch (error) {
      const current = readAuthSession();
      if (current && current.session.refresh_token !== stored.session.refresh_token) return current.session;
      if (error instanceof AuthApiError && error.status === 401 && current) clearAuthSession();
      throw error;
    }
  };
  // Refresh tokens are rotated by the backend: serialize tabs as well as requests.
  const pending = typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('ai-safety-auth-refresh', renew).then(session => session)
    : renew();
  refreshInFlight = pending;
  try { return await pending; }
  finally { if (refreshInFlight === pending) refreshInFlight = null; }
}

export async function maintainAuthSession(): Promise<void> {
  const stored = readAuthSession();
  if (!stored) return;
  const expiry = tokenExpiry(stored.session);
  if (expiry !== null && expiry <= Date.now() + 60000) await renewAuthSession(stored.session);
}

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), API_BASE);
  const api = new URL(API_BASE);
  if (url.origin !== api.origin || !url.pathname.startsWith('/api/')
      || ['/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout'].includes(url.pathname)) {
    return fetch(input, init);
  }
  const stored = readAuthSession();
  if (!stored) return fetch(input, init);
  try { await maintainAuthSession(); }
  catch (error) {
    // A temporary outage should not erase the session or log out the user.
    const expiry = tokenExpiry(stored.session);
    if (error instanceof AuthApiError && error.status === 401) throw error;
    if (expiry !== null && expiry <= Date.now()) throw error;
  }
  const current = readAuthSession();
  if (!current) throw new AuthApiError('Vui lòng đăng nhập để tiếp tục.', 401);
  if (current.session.user.id !== stored.session.user.id) throw new AuthApiError('Tài khoản đăng nhập đã thay đổi.', 401);
  const request = new Request(input, init);
  const retryRequest = request.clone();
  const send = (source: Request, accessToken: string) => {
    source.signal.throwIfAborted();
    const headers = new Headers(source.headers);
    headers.set('Authorization', 'Bearer ' + accessToken);
    return fetch(new Request(source, { headers }));
  };
  const response = await send(request, current.session.access_token);
  if (response.status !== 401) return response;
  retryRequest.signal.throwIfAborted();
  const refreshed = await renewAuthSession(current.session);
  if (!refreshed) throw new AuthApiError('Vui lòng đăng nhập để tiếp tục.', 401);
  if (refreshed.user.id !== stored.session.user.id) throw new AuthApiError('Tài khoản đăng nhập đã thay đổi.', 401);
  // Only an authentication rejection is retried, once. Never retry other mutations.
  return send(retryRequest, refreshed.access_token);
}

export async function restoreAuthSession(): Promise<AuthSession | null> {
  const stored = readAuthSession();
  if (!stored) return null;
  try {
    const user = await getCurrentUser(stored.session.access_token);
    const current = readAuthSession();
    if (!current || current.session.user.id !== stored.session.user.id) return current?.session ?? null;
    const session = { ...current.session, user };
    saveAuthSession(session, current.remember);
    return session;
  } catch (error) {
    if (error instanceof AuthApiError && error.status === 401) return null;
    return readAuthSession()?.session ?? null;
  }
}

export async function logoutAccount(): Promise<void> {
  const stored = readAuthSession();
  clearAuthSession();
  if (stored) {
    await apiRequest<void>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: stored.session.refresh_token }),
    });
  }
}

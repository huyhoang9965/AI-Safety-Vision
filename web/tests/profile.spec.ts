import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { ApiUser } from '../lib/auth';

const storageKey = 'ai-safety-auth-session-v1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8u8AAAAASUVORK5CYII=', 'base64');
const token = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature';

async function setup(context: BrowserContext, options: { remember?: boolean; noDashboardPermission?: boolean } = {}) {
  const account: ApiUser = {
    id: 'a714b865-20cd-49a0-b1aa-cc8a069efc6f', email: 'profile@example.test', username: 'profile-user',
    full_name: 'Nguyễn An', department: 'An toàn lao động', job_title: 'Nhân viên giám sát', phone: null,
    avatar_url: null, status: 'active', email_verified: true, birthday: null, gender: null, bio: '',
    created_at: '2026-01-15T00:00:00Z', password_changed_at: '2026-01-15T00:00:00Z',
    memberships: [{ organization_id: 'test-org', organization_code: 'TEST', organization_name: 'Nhà máy thử nghiệm',
      role_code: 'viewer', role_name: 'Nhân viên', is_default: true, permissions: options.noDashboardPermission ? [] : ['dashboard.view'] }],
  };
  const state = { user: account, saves: [] as Record<string, unknown>[], passwords: [] as Record<string, unknown>[],
    saveFailure: false, wrongCurrentPassword: false, token, refreshToken: 'initial-refresh-token' };
  await context.addInitScript(({ storageKey, account, token, remember }) => {
    if (localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey) || sessionStorage.getItem('profile-seeded')) return;
    sessionStorage.setItem('profile-seeded', 'true');
    (remember ? localStorage : sessionStorage).setItem(storageKey, JSON.stringify({ access_token: token,
      refresh_token: 'initial-refresh-token', token_type: 'bearer', expires_in: 3600, user: account }));
  }, { storageKey, account, token, remember: options.remember !== false });
  await context.route('**/avatars/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/health') { await route.fulfill({ json: { status: 'ok', database: 'connected', loaded_models: [], test_videos: 0 } }); return; }
    if (path === '/api/models') { await route.fulfill({ json: [] }); return; }
    if (request.headers().authorization !== 'Bearer ' + state.token) {
      await route.fulfill({ status: 401, json: { detail: 'Phiên đăng nhập không hợp lệ' } }); return;
    }
    if (path === '/api/auth/me' && request.method() === 'GET') { await route.fulfill({ json: state.user }); return; }
    if (path === '/api/auth/me' && request.method() === 'POST') {
      const payload = request.postDataJSON(); state.saves.push(payload);
      if (state.saveFailure) { await route.fulfill({ status: 503, json: { detail: 'Không thể lưu hồ sơ. Vui lòng thử lại' } }); return; }
      const { avatar_data, remove_avatar, ...fields } = payload;
      state.user = { ...state.user, ...fields,
        avatar_url: remove_avatar ? null : avatar_data ? '/avatars/profile-test.png' : state.user.avatar_url };
      await route.fulfill({ json: state.user }); return;
    }
    if (path === '/api/auth/me/password') {
      state.passwords.push(request.postDataJSON());
      if (state.wrongCurrentPassword) { await route.fulfill({ status: 400, json: { detail: 'Mật khẩu hiện tại không chính xác' } }); return; }
      state.token = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.rotated';
      state.refreshToken = 'new-refresh-token';
      state.user = { ...state.user, password_changed_at: new Date().toISOString() };
      await route.fulfill({ json: { access_token: state.token, refresh_token: state.refreshToken,
        token_type: 'bearer', expires_in: 3600, user: state.user } }); return;
    }
    throw new Error('Unexpected profile API request: ' + path);
  });
  return state;
}

async function ready(page: Page) {
  await page.goto('/dashboard/profile');
  await expect(page.getByRole('heading', { name: 'Hồ sơ của tôi' })).toBeVisible();
  await expect(page.getByLabel('Họ và tên')).toHaveValue('Nguyễn An');
}

test('account dropdown opens the actual profile route without settings permission', async ({ context, page }, testInfo) => {
  await setup(context);
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Tài khoản Nguyễn An', exact: true }).click();
  await page.getByRole('link', { name: 'Hồ sơ cá nhân', exact: true }).last().click();
  await expect(page).toHaveURL(/\/dashboard\/profile$/);
  await expect(page.getByLabel('Họ và tên')).toHaveValue('Nguyễn An');
  await expect(page.getByText('Bản xem thử')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('profile-desktop.png'), fullPage: true });
});

for (const remember of [true, false]) test(`profile save updates the account menu and survives reload with ${remember ? 'local' : 'session'} storage`, async ({ context, page }) => {
  const state = await setup(context, { remember });
  await ready(page);
  await page.getByLabel('Họ và tên').fill('Nguyễn An Cập Nhật');
  await page.getByLabel('Số điện thoại').fill('0901234567');
  await page.getByLabel('Giới thiệu ngắn').fill('Phụ trách giám sát an toàn.');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByText(/Đã cập nhật hồ sơ của bạn/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tài khoản Nguyễn An Cập Nhật', exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).not.toHaveProperty('id');
  expect(state.saves[0]).not.toHaveProperty('memberships');
  await page.reload();
  await expect(page.getByLabel('Họ và tên')).toHaveValue('Nguyễn An Cập Nhật');
  await expect(page.getByLabel('Số điện thoại')).toHaveValue('0901234567');
  const stored = await page.evaluate(({ storageKey, remember }) => ({
    account: JSON.parse((remember ? localStorage : sessionStorage).getItem(storageKey)!).user,
    other: (remember ? sessionStorage : localStorage).getItem(storageKey),
  }), { storageKey, remember });
  expect(stored.account.full_name).toBe(state.user.full_name);
  expect(stored.other).toBeNull();
});

test('failed save retains edits and discard restores the last saved values', async ({ context, page }) => {
  const state = await setup(context);
  await ready(page); state.saveFailure = true;
  await page.getByLabel('Họ và tên').fill('Tên chưa lưu');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByText('Không thể lưu hồ sơ. Vui lòng thử lại')).toBeVisible();
  await expect(page.getByLabel('Họ và tên')).toHaveValue('Tên chưa lưu');
  await page.getByRole('button', { name: 'Hủy thay đổi', exact: true }).click();
  await expect(page.getByLabel('Họ và tên')).toHaveValue('Nguyễn An');
  await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true })).toBeDisabled();
});

test('avatar upload updates the dashboard image and can be removed', async ({ context, page }) => {
  const state = await setup(context); await ready(page);
  await page.getByLabel('Tệp ảnh đại diện', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByText(/Đã cập nhật hồ sơ của bạn/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tài khoản Nguyễn An', exact: true }).locator('img')).toHaveAttribute('src', /\/avatars\/profile-test.png$/);
  expect(state.saves[0].avatar_data).toMatch(/^data:image\/png;base64,/);
  await page.getByRole('button', { name: 'Xóa ảnh', exact: true }).click();
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect.poll(() => state.user.avatar_url).toBeNull();
  await expect(page.getByRole('button', { name: 'Tài khoản Nguyễn An', exact: true }).locator('img')).toHaveCount(0);
});

test('password confirmation and wrong current password keep the existing session', async ({ context, page }) => {
  const state = await setup(context); await ready(page);
  await page.getByRole('tab', { name: 'Bảo mật & mật khẩu' }).click();
  await page.getByLabel(/^Mật khẩu hiện tại/).fill('WrongPassword123!');
  await page.getByLabel(/^Mật khẩu mới/).fill('NewPassword123!');
  await page.getByLabel(/^Nhập lại mật khẩu mới/).fill('Mismatch123!');
  await page.getByRole('button', { name: 'Đổi mật khẩu', exact: true }).click();
  await expect(page.getByText('Mật khẩu nhập lại chưa khớp.')).toBeVisible();
  expect(state.passwords).toHaveLength(0);
  await page.getByLabel(/^Nhập lại mật khẩu mới/).fill('NewPassword123!');
  state.wrongCurrentPassword = true;
  await page.getByRole('button', { name: 'Đổi mật khẩu', exact: true }).click();
  await expect(page.getByText('Mật khẩu hiện tại không chính xác')).toBeVisible();
  await expect(page).toHaveURL(/dashboard\/profile/);
  expect(await page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).refresh_token, storageKey)).toBe('initial-refresh-token');
});

test('password success rotates credentials and never stores password text', async ({ context, page }) => {
  const state = await setup(context); await ready(page);
  await page.getByRole('tab', { name: 'Bảo mật & mật khẩu' }).click();
  await page.getByLabel(/^Mật khẩu hiện tại/).fill('OldPassword123!');
  await page.getByLabel(/^Mật khẩu mới/).fill('NewPassword123!');
  await page.getByLabel(/^Nhập lại mật khẩu mới/).fill('NewPassword123!');
  await page.getByRole('button', { name: 'Đổi mật khẩu', exact: true }).click();
  await expect(page.getByText(/Đã đổi mật khẩu thành công/)).toBeVisible();
  await expect(page.getByLabel(/^Mật khẩu hiện tại/)).toHaveValue('');
  const stored = await page.evaluate(storageKey => localStorage.getItem(storageKey)!, storageKey);
  expect(JSON.parse(stored).refresh_token).toBe(state.refreshToken);
  expect(stored).not.toContain('OldPassword123!');
  expect(stored).not.toContain('NewPassword123!');
  await page.getByRole('tab', { name: 'Thông tin cá nhân' }).click();
  await page.getByLabel('Họ và tên').fill('Sau khi đổi mật khẩu');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await expect(page.getByText(/Đã cập nhật hồ sơ của bạn/)).toBeVisible();
});

test('profile is available to an authenticated account without dashboard permission and fits mobile', async ({ context, page }, testInfo) => {
  await setup(context, { noDashboardPermission: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page).toHaveURL(/dashboard\/profile/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Bảo mật & mật khẩu' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('profile-mobile.png'), fullPage: true });
});

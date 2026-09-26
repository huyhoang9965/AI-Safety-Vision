'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Camera,
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  Command,
  Eye,
  FileWarning,
  LayoutDashboard,
  LogOut,
  Menu,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Siren,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { defaultAppPath, logoutAccount, restoreAuthSession, userPermissions, userRole, type ApiUser } from '@/lib/auth';
import styles from './dashboard.module.css';
import AdminChatbot from './admin-chatbot';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
};

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Vận hành',
    items: [
      { label: 'Tổng quan', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Giám sát trực tiếp', href: '/dashboard/live', icon: Radio },
      { label: 'Cảnh báo & vi phạm', href: '/dashboard/alerts', icon: Siren },
      { label: 'Quản lý sự cố', href: '/dashboard/incidents', icon: FileWarning },
    ],
  },
  {
    label: 'Hạ tầng AI',
    items: [
      { label: 'Camera & khu vực', href: '/dashboard/cameras', icon: Camera },
      { label: 'Mô hình AI', href: '/dashboard/models', icon: Bot },
    ],
  },
  {
    label: 'Phân tích',
    items: [
      { label: 'Báo cáo & thống kê', href: '/dashboard/reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Quản trị',
    items: [
      { label: 'Người dùng & phân quyền', href: '/dashboard/users', icon: Users },
      { label: 'Cấu hình hệ thống', href: '/dashboard/settings', icon: Settings },
    ],
  },
];

const allItems = navGroups.flatMap(group => group.items);

const routePermissions: Record<string, string> = {
  '/dashboard': 'dashboard.view',
  '/dashboard/live': 'camera.view',
  '/dashboard/alerts': 'event.view',
  '/dashboard/incidents': 'incident.view',
  '/dashboard/cameras': 'camera.manage',
  '/dashboard/models': 'camera.manage',
  '/dashboard/reports': 'report.view',
  '/dashboard/users': 'user.view',
  '/dashboard/settings': 'settings.manage',
};

function activeItem(pathname: string): NavItem {
  return allItems.find(item => item.href === pathname)
    || allItems.find(item => item.href !== '/dashboard' && pathname.startsWith(item.href))
    || allItems[0];
}

export default function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<ApiUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const permissions = useMemo(() => user ? userPermissions(user) : new Set<string>(), [user]);
  const visibleGroups = useMemo(
    () => navGroups
      .map(group => ({
        ...group,
        items: group.items.filter(item => permissions.has(routePermissions[item.href])),
      }))
      .filter(group => group.items.length > 0),
    [permissions],
  );
  const current = useMemo(() => activeItem(pathname), [pathname]);

  useEffect(() => {
    let cancelled = false;
    void restoreAuthSession().then(session => {
      if (cancelled) return;
      if (!session) {
        router.replace('/');
        return;
      }
      const requested = activeItem(pathname);
      if (!userPermissions(session.user).has(routePermissions[requested.href])) {
        router.replace(defaultAppPath(session.user) || '/');
        return;
      }
      setUser(session.user);
      setAuthReady(true);
    });
    return () => { cancelled = true; };
  }, [pathname, router]);

  useEffect(() => {
    if (!authReady) return;
    const controller = new AbortController();
    const checkHealth = async () => {
      try {
        const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
        const response = await fetch(base + '/api/health', { signal: controller.signal });
        setBackendOnline(response.ok);
      } catch {
        if (!controller.signal.aborted) setBackendOnline(false);
      }
    };
    void checkHealth();
    const timer = window.setInterval(checkHealth, 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [authReady]);

  useEffect(() => {
    setMobileOpen(false);
    setNotificationsOpen(false);
    setProfileOpen(false);
  }, [pathname]);

  const handleLogout = async () => {
    setUser(null);
    try {
      await logoutAccount();
    } finally {
      router.replace('/');
    }
  };

  if (!authReady || !user) {
    return (
      <div className={styles.authLoading}>
        <span className={styles.loadingMark}><ShieldCheck size={24} /></span>
        <strong>Đang xác minh phiên đăng nhập</strong>
        <small>AI Safety Monitoring</small>
      </div>
    );
  }

  const shellClass = collapsed ? styles.shell + ' ' + styles.collapsed : styles.shell;
  const sidebarClass = mobileOpen ? styles.sidebar + ' ' + styles.mobileOpen : styles.sidebar;

  return (
    <div className={shellClass}>
      {mobileOpen && <button className={styles.backdrop} onClick={() => setMobileOpen(false)} aria-label="Đóng menu" />}

      <aside className={sidebarClass}>
        <div className={styles.brandRow}>
          <Link href={defaultAppPath(user) || '/'} className={styles.brand}>
            <span className={styles.brandIcon}><ShieldCheck size={21} /></span>
            <span className={styles.brandText}>
              <strong>AI SAFETY</strong>
              <small>MONITORING PLATFORM</small>
            </span>
          </Link>
          <button className={styles.mobileClose} onClick={() => setMobileOpen(false)} aria-label="Đóng menu">
            <X size={18} />
          </button>
        </div>

        <div className={styles.workspace}>
          <span className={styles.workspaceLogo}>SF</span>
          <span className={styles.workspaceText}>
            <small>Không gian làm việc</small>
            <strong>Safety Operations</strong>
          </span>
          <ChevronDown size={14} />
        </div>

        <nav className={styles.navigation} aria-label="Điều hướng dashboard">
          {visibleGroups.map(group => (
            <div className={styles.navGroup} key={group.label}>
              <span className={styles.navGroupLabel}>{group.label}</span>
              {group.items.map(item => {
                const Icon = item.icon;
                const selected = item.href === '/dashboard'
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={selected ? styles.navItem + ' ' + styles.navItemActive : styles.navItem}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {item.badge && <em>{item.badge}</em>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarStatus}>
            <i className={backendOnline ? styles.onlineDot : backendOnline === false ? styles.offlineDot : styles.pendingDot} />
            <span>
              <strong>{backendOnline ? 'Hệ thống hoạt động' : backendOnline === false ? 'Mất kết nối backend' : 'Đang kiểm tra'}</strong>
              <small>{backendOnline ? 'Đồng bộ 30 giây/lần' : 'FastAPI · PostgreSQL'}</small>
            </span>
          </div>
          <button className={styles.collapseButton} onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Mở rộng sidebar' : 'Thu gọn sidebar'}>
            <ChevronLeft size={17} />
            <span>Thu gọn menu</span>
          </button>
        </div>
      </aside>

      <div className={styles.workspaceMain}>
        <header className={styles.topbar}>
          <div className={styles.topbarTitle}>
            <button className={styles.menuButton} onClick={() => setMobileOpen(true)} aria-label="Mở menu">
              <Menu size={20} />
            </button>
            <div>
              <span>AI Safety / {current.label}</span>
              <strong>{current.label}</strong>
            </div>
          </div>

          <div className={styles.topbarActions}>
            <label className={styles.search}>
              <Search size={16} />
              <input aria-label="Tìm kiếm" placeholder="Tìm kiếm toàn hệ thống..." />
              <kbd><Command size={11} /> K</kbd>
            </label>

            <Link
              href="/demo"
              className={styles.demoLink}
              aria-label="Xem trang Demo trực quan"
              title="Xem trang Demo trực quan"
            >
              <Eye size={16} />
              <span>Xem trang Demo</span>
            </Link>

            <div className={styles.actionWrap}>
              <button
                className={styles.iconButton}
                onClick={() => { setNotificationsOpen(value => !value); setProfileOpen(false); }}
                aria-label="Thông báo"
                aria-expanded={notificationsOpen}
              >
                <Bell size={18} />
                <i />
              </button>
              {notificationsOpen && (
                <div className={styles.popover}>
                  <div className={styles.popoverHead}>
                    <strong>Thông báo</strong>
                    <span>0 chưa đọc</span>
                  </div>
                  <div className={styles.emptyPopover}>
                    <Bell size={22} />
                    <strong>Chưa có thông báo mới</strong>
                    <small>Cảnh báo hệ thống sẽ xuất hiện tại đây.</small>
                  </div>
                </div>
              )}
            </div>

            <div className={styles.actionWrap}>
              <button
                className={styles.profileButton}
                onClick={() => { setProfileOpen(value => !value); setNotificationsOpen(false); }}
                aria-expanded={profileOpen}
              >
                <span>{user.full_name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{user.full_name}</strong>
                  <small>{userRole(user)}</small>
                </div>
                <ChevronDown size={14} />
              </button>
              {profileOpen && (
                <div className={styles.profileMenu}>
                  <div className={styles.profileSummary}>
                    <span>{user.full_name.slice(0, 1).toUpperCase()}</span>
                    <div><strong>{user.full_name}</strong><small>{user.email}</small></div>
                  </div>
                  {permissions.has('settings.manage') && (
                    <Link href="/dashboard/settings"><CircleUserRound size={16} /> Hồ sơ cá nhân</Link>
                  )}
                  <button onClick={() => void handleLogout()}><LogOut size={16} /> Đăng xuất</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className={styles.content}>{children}</main>
        <footer className={styles.dashboardFooter}>
          <span>AI Safety Monitoring Platform</span>
          <span><Activity size={13} /> Hệ thống hỗ trợ giám sát — không thay thế quy trình an toàn tại hiện trường.</span>
        </footer>
        {permissions.has('chat.use') && user && <AdminChatbot user={user} />}
      </div>
    </div>
  );
}

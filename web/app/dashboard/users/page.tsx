import type { Metadata } from 'next';
import UsersManagement from '@/components/dashboard/users-management';

export const metadata: Metadata = {
  title: 'Người dùng & phân quyền | AI Safety Monitoring',
  description: 'Quản trị tài khoản, vai trò, quyền truy cập và phạm vi nhà máy.',
};

export default function UsersPage() {
  return <UsersManagement />;
}

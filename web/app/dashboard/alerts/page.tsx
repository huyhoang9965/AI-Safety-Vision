import type { Metadata } from 'next';
import AlertsManagement from '@/components/dashboard/alerts-management';

export const metadata: Metadata = {
  title: 'Cảnh báo và vi phạm | AI Safety Monitoring',
  description: 'Tiếp nhận, xác minh và xử lý cảnh báo an toàn từ hệ thống AI.',
};

export default function AlertsPage() {
  return <AlertsManagement />;
}

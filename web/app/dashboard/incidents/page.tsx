import type { Metadata } from 'next';
import IncidentsManagement from '@/components/dashboard/incidents-management';

export const metadata: Metadata = {
  title: 'Quản lý sự cố | AI Safety Monitoring',
  description: 'Điều phối, phân công và theo dõi vòng đời sự cố an toàn.',
};

export default function IncidentsPage() {
  return <IncidentsManagement />;
}

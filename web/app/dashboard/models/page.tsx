import type { Metadata } from 'next';
import ModelsManagement from '@/components/dashboard/models-management';

export const metadata: Metadata = {
  title: 'Mô hình AI | AI Safety Monitoring',
  description: 'Quản trị mô hình, hiệu năng inference và triển khai AI lên camera.',
};

export default function ModelsPage() {
  return <ModelsManagement />;
}

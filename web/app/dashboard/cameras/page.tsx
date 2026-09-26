import type { Metadata } from 'next';
import CamerasManagement from '@/components/dashboard/cameras-management';

export const metadata: Metadata = {
  title: 'Camera và khu vực | AI Safety Monitoring',
  description: 'Quản trị nhà máy, khu vực, camera và sức khỏe thiết bị giám sát.',
};

export default function CamerasPage() {
  return <CamerasManagement />;
}

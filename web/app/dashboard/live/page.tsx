import type { Metadata } from 'next';
import LiveMonitoring from '@/components/dashboard/live-monitoring';

export const metadata: Metadata = {
  title: 'Giám sát trực tiếp | AI Safety Monitoring',
  description: 'Trung tâm giám sát camera và phân tích an toàn bằng AI.',
};

export default function LiveMonitoringPage() {
  return <LiveMonitoring />;
}

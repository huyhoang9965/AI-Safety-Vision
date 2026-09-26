import type { Metadata } from 'next';
import ReportsAnalytics from '@/components/dashboard/reports-analytics';

export const metadata: Metadata = {
  title: 'Báo cáo & thống kê | AI Safety Monitoring',
  description: 'Phân tích xu hướng an toàn, hiệu quả xử lý và điểm nóng rủi ro.',
};

export default function ReportsPage() {
  return <ReportsAnalytics />;
}

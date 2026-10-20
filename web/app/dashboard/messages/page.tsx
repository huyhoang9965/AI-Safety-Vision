import type { Metadata } from 'next';
import TeamMessaging from '@/components/dashboard/team-messaging';

export const metadata: Metadata = {
  title: 'Tin nhắn & yêu cầu | AI Safety Monitoring',
  description: 'Kết nối nhân viên giám sát và quản trị viên, trao đổi công việc và theo dõi yêu cầu nội bộ.',
};

export default function MessagesPage() {
  return <TeamMessaging />;
}

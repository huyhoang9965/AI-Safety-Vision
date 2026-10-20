import type { Metadata } from 'next';
import PersonalProfile from '@/components/dashboard/personal-profile';

export const metadata: Metadata = {
  title: 'Hồ sơ cá nhân | AI Safety Monitoring',
  description: 'Cập nhật thông tin, ảnh đại diện và mật khẩu của tài khoản đang đăng nhập.',
};

export default function ProfilePage() {
  return <PersonalProfile />;
}

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BellRing,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileBarChart,
  FileWarning,
  Radio,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import styles from '@/components/dashboard/section.module.css';

type SectionConfig = {
  title: string;
  eyebrow: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  features: Array<{ title: string; description: string; icon: LucideIcon }>;
  data: string[];
  nextSteps: string[];
};

const sections: Record<string, SectionConfig> = {
  live: {
    title: 'Giám sát trực tiếp',
    eyebrow: 'VẬN HÀNH THỜI GIAN THỰC',
    description: 'Không gian theo dõi camera tập trung, hiển thị lớp nhận diện AI và tình trạng từng luồng hình.',
    icon: Radio,
    accent: 'blue',
    features: [
      { title: 'Lưới camera linh hoạt', description: 'Chuyển nhanh giữa bố cục 1, 4, 9 hoặc nhiều luồng.', icon: Camera },
      { title: 'Overlay nhận diện AI', description: 'Hiện vùng nhận diện, nhãn vi phạm và độ tin cậy.', icon: Sparkles },
      { title: 'Tạo sự cố tức thời', description: 'Chụp bằng chứng và mở phiếu xử lý ngay từ luồng live.', icon: FileWarning },
    ],
    data: ['camera_streams', 'camera_health_logs', 'safety_events', 'event_evidence'],
    nextSteps: ['Kết nối RTSP/WebRTC', 'Thêm bộ chọn site và khu vực', 'Xây dựng bảng điều khiển PTZ'],
  },
  alerts: {
    title: 'Quản lý cảnh báo',
    eyebrow: 'PHÁT HIỆN VÀ XÁC MINH',
    description: 'Tập trung cảnh báo AI, ưu tiên theo mức nghiêm trọng và kiểm soát toàn bộ quá trình xác minh.',
    icon: BellRing,
    accent: 'orange',
    features: [
      { title: 'Hàng đợi ưu tiên', description: 'Sắp xếp cảnh báo theo rủi ro, thời gian và khu vực.', icon: BellRing },
      { title: 'Xác minh bằng chứng', description: 'Xem ảnh, video và kết quả mô hình trước khi xử lý.', icon: ClipboardCheck },
      { title: 'Giảm cảnh báo sai', description: 'Ghi nhận phản hồi để tinh chỉnh ngưỡng nhận diện.', icon: SlidersHorizontal },
    ],
    data: ['safety_events', 'event_evidence', 'event_reviews', 'alert_deliveries'],
    nextSteps: ['Tạo API danh sách sự kiện', 'Thêm bộ lọc nâng cao', 'Thiết kế panel xác minh'],
  },
  incidents: {
    title: 'Quản lý sự cố',
    eyebrow: 'ĐIỀU PHỐI XỬ LÝ',
    description: 'Theo dõi vòng đời sự cố từ khi tiếp nhận, phân công, xử lý cho đến khi đóng và đánh giá.',
    icon: FileWarning,
    accent: 'red',
    features: [
      { title: 'Quy trình trạng thái', description: 'Quản lý mới, đang xử lý, chờ xác nhận và đã đóng.', icon: Activity },
      { title: 'Phân công trách nhiệm', description: 'Giao người xử lý, người giám sát và thời hạn SLA.', icon: Users },
      { title: 'Hồ sơ điều tra', description: 'Lưu nguyên nhân, hành động khắc phục và bằng chứng.', icon: ClipboardCheck },
    ],
    data: ['incidents', 'incident_assignments', 'incident_comments', 'incident_status_history'],
    nextSteps: ['Thiết kế Kanban sự cố', 'Thêm SLA và nhắc hạn', 'Xây dựng nhật ký cộng tác'],
  },
  cameras: {
    title: 'Camera và khu vực',
    eyebrow: 'HẠ TẦNG GIÁM SÁT',
    description: 'Quản lý cấu trúc nhà máy, khu vực, camera, thông số luồng và tình trạng kết nối.',
    icon: Camera,
    accent: 'cyan',
    features: [
      { title: 'Sơ đồ phân cấp', description: 'Tổ chức theo doanh nghiệp, nhà máy, khu vực và camera.', icon: Camera },
      { title: 'Cấu hình luồng', description: 'Quản lý RTSP, ảnh xem trước và thông số kết nối.', icon: SlidersHorizontal },
      { title: 'Theo dõi sức khỏe', description: 'Phát hiện ngoại tuyến, độ trễ cao hoặc lỗi luồng.', icon: Activity },
    ],
    data: ['organizations', 'sites', 'zones', 'cameras', 'camera_health_logs'],
    nextSteps: ['Tạo CRUD camera', 'Bổ sung kiểm tra RTSP', 'Xây dựng bản đồ khu vực'],
  },
  models: {
    title: 'Mô hình AI',
    eyebrow: 'AI PIPELINE',
    description: 'Quản lý phiên bản mô hình, triển khai lên camera và cấu hình ngưỡng phát hiện an toàn.',
    icon: Sparkles,
    accent: 'violet',
    features: [
      { title: 'Registry mô hình', description: 'Theo dõi RF-DETR, VideoMAE và phiên bản artifact.', icon: Sparkles },
      { title: 'Cấu hình triển khai', description: 'Gán mô hình, lớp nhận diện và ngưỡng cho camera.', icon: SlidersHorizontal },
      { title: 'Đánh giá hiệu năng', description: 'Quan sát latency, độ tin cậy và tỷ lệ cảnh báo sai.', icon: Activity },
    ],
    data: ['ai_models', 'model_versions', 'camera_model_deployments', 'detection_results'],
    nextSteps: ['Đồng bộ API model hiện có', 'Thêm màn hình deployment', 'Vẽ biểu đồ chất lượng'],
  },
  reports: {
    title: 'Báo cáo và phân tích',
    eyebrow: 'DỮ LIỆU AN TOÀN',
    description: 'Tổng hợp xu hướng vi phạm, hiệu quả xử lý và mức độ an toàn theo thời gian, site và khu vực.',
    icon: FileBarChart,
    accent: 'green',
    features: [
      { title: 'Xu hướng rủi ro', description: 'Phân tích theo ngày, loại vi phạm và mức nghiêm trọng.', icon: Activity },
      { title: 'Hiệu quả xử lý', description: 'Đo thời gian xác nhận, SLA và tỷ lệ đóng sự cố.', icon: CheckCircle2 },
      { title: 'Xuất báo cáo', description: 'Chuẩn bị báo cáo PDF, Excel cho quản lý và kiểm toán.', icon: FileBarChart },
    ],
    data: ['daily_safety_statistics', 'safety_events', 'incidents', 'audit_logs'],
    nextSteps: ['Chốt bộ KPI', 'Thêm bộ lọc thời gian', 'Xây dựng chức năng xuất file'],
  },
  users: {
    title: 'Người dùng và phân quyền',
    eyebrow: 'QUẢN TRỊ TRUY CẬP',
    description: 'Quản lý tài khoản, vai trò, quyền thao tác và phạm vi dữ liệu được phép truy cập.',
    icon: Users,
    accent: 'indigo',
    features: [
      { title: 'Vòng đời tài khoản', description: 'Mời, kích hoạt, khóa và quản lý thông tin người dùng.', icon: Users },
      { title: 'Vai trò và quyền', description: 'Phân quyền chi tiết theo từng chức năng hệ thống.', icon: ShieldCheck },
      { title: 'Nhật ký truy cập', description: 'Theo dõi đăng nhập và các hành động quản trị quan trọng.', icon: ClipboardCheck },
    ],
    data: ['users', 'roles', 'permissions', 'user_roles', 'role_permissions', 'audit_logs'],
    nextSteps: ['Tạo API danh sách người dùng', 'Thiết kế trình phân quyền', 'Thêm khóa và mở tài khoản'],
  },
  settings: {
    title: 'Cài đặt hệ thống',
    eyebrow: 'CẤU HÌNH NỀN TẢNG',
    description: 'Thiết lập tổ chức, chính sách thông báo, lưu trữ dữ liệu và các tùy chọn bảo mật chung.',
    icon: Settings,
    accent: 'slate',
    features: [
      { title: 'Cấu hình tổ chức', description: 'Thông tin đơn vị, múi giờ và quy ước vận hành.', icon: Settings },
      { title: 'Kênh thông báo', description: 'Thiết lập email, webhook và quy tắc gửi cảnh báo.', icon: BellRing },
      { title: 'Chính sách dữ liệu', description: 'Quản lý thời gian lưu trữ và yêu cầu kiểm toán.', icon: ShieldCheck },
    ],
    data: ['organizations', 'notification_channels', 'notification_rules', 'system_settings'],
    nextSteps: ['Xác định cài đặt ưu tiên', 'Tạo API cấu hình', 'Bổ sung kiểm tra quyền admin'],
  },
};

export function generateStaticParams() {
  return Object.keys(sections)
    .filter(section => !['live', 'alerts', 'incidents', 'cameras', 'users', 'models', 'reports', 'settings'].includes(section))
    .map(section => ({ section }));
}

export default async function DashboardSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const config = sections[section];
  if (!config) notFound();

  const MainIcon = config.icon;

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>{config.eyebrow}</span>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
        </div>
        <Link href="/dashboard"><ArrowLeft size={15} /> Tổng quan</Link>
      </header>

      <section className={styles.stageBanner} data-accent={config.accent}>
        <span className={styles.mainIcon}><MainIcon size={28} /></span>
        <div>
          <strong>Khung chức năng đã sẵn sàng</strong>
          <p>Trang này đã nằm trong cấu trúc dashboard. Bạn có thể phát triển giao diện nghiệp vụ mà không cần thay đổi sidebar, topbar hoặc luồng xác thực.</p>
        </div>
        <em>GIAI ĐOẠN TIẾP THEO</em>
      </section>

      <div className={styles.featureGrid}>
        {config.features.map(feature => {
          const FeatureIcon = feature.icon;
          return (
            <article key={feature.title}>
              <span><FeatureIcon size={19} /></span>
              <strong>{feature.title}</strong>
              <p>{feature.description}</p>
              <small>Thiết kế chi tiết sau</small>
            </article>
          );
        })}
      </div>

      <div className={styles.detailGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div>
              <strong>Hợp đồng dữ liệu dự kiến</strong>
              <span>Các bảng PostgreSQL sẽ phục vụ module này</span>
            </div>
            <ShieldCheck size={18} />
          </div>
          <div className={styles.dataList}>
            {config.data.map((item, index) => (
              <div key={item}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <code>{item}</code>
                <em>Đã có schema</em>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div>
              <strong>Lộ trình triển khai giao diện</strong>
              <span>Các đầu việc khi bắt đầu module chi tiết</span>
            </div>
            <ClipboardCheck size={18} />
          </div>
          <div className={styles.checkList}>
            {config.nextSteps.map((step, index) => (
              <div key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
                <ArrowRight size={14} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

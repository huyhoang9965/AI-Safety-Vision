import styles from '@/components/dashboard/section.module.css';

export default function DashboardLoading() {
  return (
    <div className={styles.page} aria-label="Đang tải dashboard">
      <div style={{ height: 74, borderRadius: 14, background: '#e9edf4' }} />
      <div style={{ height: 92, borderRadius: 14, background: '#eef1f6' }} />
      <div className={styles.featureGrid}>
        <div style={{ height: 120, borderRadius: 14, background: '#eef1f6' }} />
        <div style={{ height: 120, borderRadius: 14, background: '#eef1f6' }} />
        <div style={{ height: 120, borderRadius: 14, background: '#eef1f6' }} />
      </div>
    </div>
  );
}

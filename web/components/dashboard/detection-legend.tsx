import detectionStyles from '@/lib/detection-styles.json';

export default function DetectionLegend() {
  return <div aria-label="Chú thích màu cảnh báo" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', padding: '10px 18px', borderTop: '1px solid #e5ecf4', background: '#fafcff', color: '#536273', fontSize: 13 }}>
    {(['Suspected no helmet', 'Suspected no vest', 'Opened Panel Cover'] as const).map(key => <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: detectionStyles[key].color }} />{detectionStyles[key].label}</span>)}
  </div>;
}

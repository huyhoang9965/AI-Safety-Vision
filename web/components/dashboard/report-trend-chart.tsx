'use client';

import { Activity, ChevronDown, ChevronUp, Pin, TrendingUp, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import styles from './report-trend-chart.module.css';

export type ReportTrend = { day: string; total: number; critical: number; resolved: number; incidents: number };
const series = [
  { key: 'total', label: 'Tổng cảnh báo', color: '#3275df' },
  { key: 'critical', label: 'Nghiêm trọng', color: '#d95755' },
  { key: 'resolved', label: 'Đã xử lý', color: '#258667' },
  { key: 'incidents', label: 'Sự cố', color: '#8b5acb' },
] as const;
type SeriesKey = typeof series[number]['key'];
const count = (value: number) => value.toLocaleString('vi-VN');
const dateLabel = (day: string, short = false) => new Date(day + 'T00:00:00Z').toLocaleDateString('vi-VN', {
  day: '2-digit', month: '2-digit', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC',
});

export default function ReportTrendChart({ rows }: { rows: ReportTrend[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [visible, setVisible] = useState<SeriesKey[]>(series.map(item => item.key));
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  const width = 900, height = 240, padding = 16;
  const maximum = Math.max(1, ...rows.map(row => Math.max(...visible.map(key => row[key]))));
  const step = Math.max(1, Math.ceil(maximum / 4)), ceiling = step * 4;
  const x = (index: number) => rows.length === 1 ? width / 2 : index * width / Math.max(rows.length - 1, 1);
  const y = (value: number) => height - padding - value / ceiling * (height - padding * 2);
  const path = (key: SeriesKey) => rows.map((row, index) => `${index ? 'L' : 'M'}${x(index)} ${y(row[key])}`).join(' ');
  const activeIndex = hovered ?? pinned;
  const active = activeIndex === null ? null : rows[activeIndex];
  const totals = Object.fromEntries(series.map(item => [item.key, rows.reduce((sum, row) => sum + row[item.key], 0)])) as Record<SeriesKey, number>;
  const peak = Math.max(0, ...rows.map(row => row.total));
  const peakDays = rows.filter(row => row.total === peak);
  const labelIndices = [...new Set([0, Math.round((rows.length - 1) / 3), Math.round((rows.length - 1) * 2 / 3), rows.length - 1])].filter(index => index >= 0);
  const values = (row: ReportTrend) => `${dateLabel(row.day)}: ` + series.map(item => `${item.label} ${count(row[item.key])}`).join(', ');

  function nearest(event: PointerEvent<SVGSVGElement> | MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(rows.length - 1, Math.round((event.clientX - rect.left) / rect.width * (rows.length - 1))));
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (rows.length && event.pointerType !== 'touch') setHovered(nearest(event));
  }
  function select(event: MouseEvent<SVGSVGElement>) {
    if (!rows.length) return;
    const index = nearest(event);
    setPinned(current => current === index ? null : index);
    setHovered(null);
  }
  function keyboard(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape') { setPinned(null); setHovered(null); return; }
    if (!rows.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = activeIndex ?? 0;
    setPinned(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))));
    setHovered(null);
  }

  return <section className={styles.panel} aria-label="Xu hướng cảnh báo">
    <header className={styles.header}><span><TrendingUp /></span><div><h2>Xu hướng cảnh báo</h2><p>Rê chuột để xem số liệu · Bấm hoặc chạm để giữ ngày đã chọn</p></div><small>{rows.length} NGÀY</small></header>
    <div className={styles.legend} aria-label="Các đường dữ liệu">{series.map(item => <button key={item.key} type="button" aria-pressed={visible.includes(item.key)} disabled={visible.length === 1 && visible.includes(item.key)} onClick={() => setVisible(current => current.includes(item.key) ? current.filter(key => key !== item.key) : [...current, item.key])}><i style={{ background: item.color }} />{item.label}<b>{count(totals[item.key])}</b></button>)}</div>
    <div className={styles.chart}>
      <div className={styles.yLabels} aria-hidden="true">{[4, 3, 2, 1, 0].map(tick => <span key={tick} style={{ top: `${y(tick * step) / height * 100}%` }}>{count(tick * step)}</span>)}</div>
      <div className={styles.plot}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="slider" aria-label="Chọn ngày trên biểu đồ xu hướng" aria-valuemin={0} aria-valuemax={Math.max(0, rows.length - 1)} aria-valuenow={activeIndex ?? 0} aria-valuetext={active ? values(active) : rows.length ? values(rows[0]) : 'Chưa có dữ liệu'} tabIndex={0} onPointerMove={move} onPointerLeave={() => setHovered(null)} onClick={select} onKeyDown={keyboard}>
          {[0, 1, 2, 3, 4].map(tick => <line key={tick} x1="0" x2={width} y1={y(tick * step)} y2={y(tick * step)} className={styles.grid} />)}
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3275df" stopOpacity=".15" /><stop offset="1" stopColor="#3275df" stopOpacity=".01" /></linearGradient></defs>
          {rows.length > 1 && visible.includes('total') && <path d={`${path('total')} L${x(rows.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={`url(#${id})`} />}
          {series.filter(item => visible.includes(item.key)).map(item => <g key={item.key} aria-hidden="true"><path d={path(item.key)} className={styles.line} style={{ stroke: item.color }} strokeDasharray={item.key === 'incidents' ? '5 4' : undefined} data-series={item.key} />{rows.length <= 31 && rows.map((row, index) => <circle key={row.day} cx={x(index)} cy={y(row[item.key])} r="3" fill="white" stroke={item.color} className={styles.point} />)}</g>)}
          {active && activeIndex !== null && <g aria-hidden="true"><line x1={x(activeIndex)} x2={x(activeIndex)} y1={padding} y2={height - padding} className={styles.cursor} />{series.filter(item => visible.includes(item.key)).map(item => <circle key={item.key} cx={x(activeIndex)} cy={y(active[item.key])} r="5" fill={item.color} stroke="white" className={styles.point} />)}</g>}
        </svg>
        <div className={styles.xLabels} aria-hidden="true">{labelIndices.map(index => rows[index] && <span key={index} style={{ left: `${x(index) / width * 100}%` }} data-edge={rows.length === 1 ? 'middle' : index === 0 ? 'first' : index === rows.length - 1 ? 'last' : 'middle'}>{dateLabel(rows[index].day, true)}</span>)}</div>
        {active && <div className={styles.tooltip} role="status" data-side={activeIndex! > (rows.length - 1) / 2 ? 'left' : 'right'}><strong>{dateLabel(active.day)} {pinned === activeIndex && <Pin aria-label="Đã giữ ngày" />}</strong>{series.map(item => <div key={item.key}><span><i style={{ background: item.color }} />{item.label}</span><b>{count(active[item.key])}</b></div>)}</div>}
        {!rows.length && <div className={styles.empty}><Activity /><strong>Chưa có dữ liệu trong kỳ</strong></div>}
      </div>
    </div>
    <div className={styles.controls}><span>{pinned !== null && rows[pinned] ? `Đang giữ ngày ${dateLabel(rows[pinned].day)}` : 'Có thể dùng phím ← → để chọn ngày, Esc để bỏ chọn.'}</span>{pinned !== null && <button onClick={() => { setPinned(null); setHovered(null); }}><X />Bỏ chọn</button>}<button aria-expanded={showTable} aria-controls={`${id}-table`} onClick={() => setShowTable(current => !current)}>{showTable ? <ChevronUp /> : <ChevronDown />}Chi tiết theo ngày</button></div>
    <div className={styles.statistics}>
      <article><span>Cảnh báo trung bình/ngày</span><strong>{rows.length ? (totals.total / rows.length).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '—'}</strong><small>Tính cả ngày không có cảnh báo</small></article>
      <article><span>Ngày nhiều cảnh báo nhất</span><strong>{peak ? count(peak) : '—'}</strong><small>{peak ? dateLabel(peakDays[0].day) + (peakDays.length > 1 ? ` · ${peakDays.length} ngày cùng mức` : '') : 'Chưa có cảnh báo'}</small></article>
      <article><span>Ngày không có cảnh báo</span><strong>{count(rows.filter(row => row.total === 0).length)}<em> / {count(rows.length)}</em></strong><small>Không khẳng định camera đã hoạt động</small></article>
      <article><span>Tỷ trọng nghiêm trọng</span><strong>{totals.total ? (totals.critical / totals.total * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%' : '—'}</strong><small>{count(totals.critical)} / {count(totals.total)} cảnh báo</small></article>
    </div>
    <p className={styles.note}>Ngày thống kê theo UTC. “Đã xử lý” là trạng thái hiện tại của cảnh báo phát hiện trong ngày. Chạm tên chỉ số để ẩn/hiện đường tương ứng.</p>
    {showTable && <div className={styles.tableWrap} id={`${id}-table`}><table><caption>Số liệu chính xác theo ngày (UTC)</caption><thead><tr><th scope="col">Ngày</th>{series.map(item => <th scope="col" key={item.key}>{item.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.day}><th scope="row">{dateLabel(row.day)}</th>{series.map(item => <td key={item.key}>{count(row[item.key])}</td>)}</tr>)}</tbody></table></div>}
  </section>;
}

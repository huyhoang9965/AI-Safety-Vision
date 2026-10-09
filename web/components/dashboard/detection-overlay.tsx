'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import detectionStyles from '@/lib/detection-styles.json';

export type OverlayFrame = {
  timestamp_seconds: number;
  end_seconds?: number;
  track_id?: number | string | null;
  class_name: string;
  bbox: number[];
};

function groupFrames(frames: OverlayFrame[]) {
  const groups = new Map<string, OverlayFrame[]>();
  for (const frame of frames) {
    const key = frame.class_name + ':' + (frame.track_id ?? 'object');
    const rows = groups.get(key) || [];
    rows.push(frame); groups.set(key, rows);
  }
  for (const rows of groups.values()) rows.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
  return groups;
}

function boxesAtTime(groups: Map<string, OverlayFrame[]>, time: number) {
  const boxes: OverlayFrame[] = [];
  for (const rows of groups.values()) {
    let low = 0, high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid].timestamp_seconds <= time) low = mid + 1;
      else high = mid;
    }
    const before = rows[low - 1];
    if (!before) continue;
    const after = rows[low];
    const gap = after ? after.timestamp_seconds - before.timestamp_seconds : Infinity;
    if (after && gap <= .65) {
      const fraction = (time - before.timestamp_seconds) / gap;
      boxes.push({ ...before, bbox: before.bbox.map((value, index) => value + (after.bbox[index] - value) * fraction) });
    } else if (time <= (before.end_seconds ?? before.timestamp_seconds + .30)) {
      boxes.push(before);
    }
  }
  return boxes;
}

export function visibleBoxes(frames: OverlayFrame[], time: number) {
  return boxesAtTime(groupFrames(frames), time);
}

export default function DetectionOverlay({ frames, time, width, height, label }: {
  frames: OverlayFrame[]; time: number; width: number; height: number; label: (name: string) => string;
}) {
  const groups = useMemo(() => groupFrames(frames), [frames]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [displayWidth, setDisplayWidth] = useState(0);
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const resize = new ResizeObserver(entries => setDisplayWidth(entries[0]?.contentRect.width || 0));
    resize.observe(node);
    return () => resize.disconnect();
  }, [width, height]);
  if (!width || !height) return null;
  return <svg ref={svgRef} aria-label="Khung đối tượng AI phát hiện" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
    {boxesAtTime(groups, time).map(frame => {
      const [x1, y1, x2, y2] = frame.bbox;
      const appearance = detectionStyles[frame.class_name as keyof typeof detectionStyles];
      const title = appearance?.label || label(frame.class_name);
      const color = appearance?.color || '#ef4444';
      const fontSize = Math.max(16, displayWidth ? 12 * width / displayWidth : width / 85), textY = Math.max(fontSize + 8, y1 - 7);
      return <g key={frame.class_name + ':' + frame.track_id} data-testid="detection-box" data-label={frame.class_name}>
        <rect x={x1} y={y1} width={Math.max(0, x2 - x1)} height={Math.max(0, y2 - y1)} fill="none" stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        <text x={x1 + 5} y={textY} fill={color} stroke="#ffffff" strokeWidth={3} paintOrder="stroke" fontSize={fontSize} fontWeight={700}>{title}</text>
      </g>;
    })}
  </svg>;
}

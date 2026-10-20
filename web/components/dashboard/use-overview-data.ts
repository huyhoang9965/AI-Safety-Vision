'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch, userPermissions } from '@/lib/auth';
import { useDashboardAccount } from './dashboard-account';
import type { ReportTrend } from './report-trend-chart';

export type DeviceStatus = 'online' | 'offline' | 'warning' | 'maintenance' | 'disabled';
export type OverviewCamera = {
  id: string; code: string; name: string; site_code: string; site_name: string;
  zone_name: string | null; snapshot_url: string | null; status: DeviceStatus;
  health_status: DeviceStatus | null; is_active: boolean; stream_configured: boolean;
  last_seen_at: string | null;
};
export type OverviewAlert = {
  id: string; title: string; camera_code: string; camera_name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'new' | 'acknowledged' | 'resolved' | 'dismissed';
  detected_at: string; overdue: boolean;
};
export type OverviewVideo = { id: number; filename: string; stream_url?: string };
type Payloads = {
  health: { status: string; database: string; test_videos: number; loaded_models: string[] };
  infrastructure: {
    cameras: OverviewCamera[]; sites: { code: string; name: string }[];
    summary: { cameras: number; online: number; offline: number; warning: number; maintenance: number; disabled: number };
  };
  videos: OverviewVideo[];
  models: { name: string; type: string; version: string; connected: boolean; loaded: boolean; status: string }[];
  alerts: {
    items: OverviewAlert[];
    summary: { today: number; total: number; new: number; acknowledged: number; resolved: number; dismissed: number; overdue: number; critical_open: number; high_open: number };
  };
  incidents: {
    items: { id: string; incident_no: number; title: string; status: 'open' | 'investigating' | 'resolved' | 'closed';
      severity: OverviewAlert['severity']; assigned_to: { full_name: string } | null; overdue: boolean }[];
    summary: { open: number; investigating: number; overdue: number; unassigned: number };
  };
  reports: { trend: ReportTrend[]; generated_at: string };
};
export type Resource<T> = { data: T | null; error: boolean; updatedAt: Date | null };
type Resources = { [K in keyof Payloads]: Resource<Payloads[K]> };
type ResourceKey = keyof Payloads;
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const sources: { key: ResourceKey; path: string; permission?: string; label: string }[] = [
  { key: 'health', path: '/api/health', label: 'Trạng thái hệ thống' },
  { key: 'infrastructure', path: '/api/infrastructure', permission: 'camera.view', label: 'Camera' },
  { key: 'videos', path: '/api/videos/test', permission: 'camera.view', label: 'Nguồn video camera' },
  { key: 'models', path: '/api/models', permission: 'camera.view', label: 'Mô hình AI' },
  { key: 'alerts', path: '/api/alerts?period=all&limit=1', permission: 'event.view', label: 'Cảnh báo' },
  { key: 'incidents', path: '/api/incidents?period=all&limit=5', permission: 'incident.view', label: 'Sự cố' },
  { key: 'reports', path: '/api/reports/overview?period=7d', permission: 'report.view', label: 'Xu hướng' },
];
function emptyResources(): Resources {
  const empty = () => ({ data: null, error: false, updatedAt: null });
  return { health: empty(), infrastructure: empty(), videos: empty(), models: empty(), alerts: empty(), incidents: empty(), reports: empty() };
}

function updateResource<K extends ResourceKey>(resources: Resources, key: K, result: PromiseSettledResult<Payloads[K]>, updatedAt: Date): Resources {
  const resource: Resource<Payloads[K]> = result.status === 'fulfilled'
    ? { data: result.value, error: false, updatedAt }
    : { ...resources[key], error: true };
  return { ...resources, [key]: resource };
}

export function useOverviewData() {
  const user = useDashboardAccount();
  const permissions = useMemo(() => userPermissions(user), [user]);
  const allowedSources = useMemo(() => sources.filter(source => !source.permission || permissions.has(source.permission)), [permissions]);
  const [resources, setResources] = useState<Resources>(emptyResources);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async (replace = false) => {
    if (request.current && !replace) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const results = await Promise.allSettled(allowedSources.map(async source => {
      const response = await authenticatedFetch(API_BASE + source.path, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw new Error('Không thể tải dữ liệu');
      return await response.json();
    }));
    if (controller.signal.aborted) return;
    const updatedAt = new Date();
    setResources(previous => {
      let next = { ...previous };
      allowedSources.forEach((source, index) => {
        next = updateResource(next, source.key, results[index], updatedAt);
      });
      return next;
    });
    request.current = null;
    setLoading(false);
  }, [allowedSources]);

  useEffect(() => {
    // Clear the previous account's data if its permission scope changes.
    setResources(emptyResources());
    void refresh(true);
    return () => { request.current?.abort(); request.current = null; };
  }, [refresh]);

  useEffect(() => {
    const update = () => {
      if (autoRefresh && document.visibilityState === 'visible') void refresh();
    };
    const timer = autoRefresh ? window.setInterval(update, 30000) : undefined;
    document.addEventListener('visibilitychange', update);
    window.addEventListener('safety-alerts-updated', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('safety-alerts-updated', update);
    };
  }, [autoRefresh, refresh]);

  return { resources, permissions, loading, autoRefresh, setAutoRefresh, refresh,
    failedSources: allowedSources.filter(source => resources[source.key].error).map(source => source.label) };
}
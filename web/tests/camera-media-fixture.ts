import type { Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const bytes = fs.readFileSync(path.resolve('tests', 'fixtures', 'camera-preview.mp4'));
export async function fulfillCameraVideo(route: Route) {
  const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = Math.min(bytes.length - 1, range?.[2] ? Number(range[2]) : bytes.length - 1);
  if (start >= bytes.length) { await route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } }); return; }
  await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4',
    headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) },
    body: bytes.subarray(start, end + 1) });
}
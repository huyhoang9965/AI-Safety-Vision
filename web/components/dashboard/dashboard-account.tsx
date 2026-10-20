'use client';

import { createContext, useContext } from 'react';
import type { ApiUser } from '@/lib/auth';

export const DashboardAccountContext = createContext<ApiUser | null>(null);

export function useDashboardAccount(): ApiUser {
  const user = useContext(DashboardAccountContext);
  if (!user) throw new Error('Trang tài khoản phải nằm trong DashboardShell.');
  return user;
}

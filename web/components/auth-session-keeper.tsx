'use client';

import { useEffect } from 'react';
import { maintainAuthSession } from '@/lib/auth';

export default function AuthSessionKeeper() {
  useEffect(() => {
    const renew = () => {
      if (document.visibilityState === 'visible') {
        void maintainAuthSession().catch(() => { /* Retry after a temporary outage. */ });
      }
    };
    renew();
    const timer = window.setInterval(renew, 30000);
    window.addEventListener('focus', renew);
    window.addEventListener('online', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', renew);
      window.removeEventListener('online', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, []);
  return null;
}

import type { Metadata } from 'next';
import DemoPage from '@/src/components/demo/DemoPage';

export const metadata: Metadata = {
  title: 'Model Demo | AI Safety Monitoring',
  description: 'Real test-video inference workspace for AI safety detection and behavior recognition models.',
};

export default function DemoRoute() {
  return <DemoPage />;
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Safety Monitoring — See risk. See what’s next.',
  description: 'An academic computer vision project exploring PPE compliance and unsafe behavior recognition with YOLO and VideoMAE.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

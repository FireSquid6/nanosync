import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Dashboard' };
export default function Dashboard() {
  return <main id="main" className="home-main"><article><h1>Dashboard</h1><p>self hosted only--managed nanosync servers coming soon</p></article></main>;
}

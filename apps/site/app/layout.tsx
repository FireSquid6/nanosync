import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeControl } from '@nanosync/ui-theme/ThemeControl';
import '@nanosync/ui-theme/styles.css';
import './styles.css';

export const metadata: Metadata = {
  title: { default: 'nanosync — File sync. On your terms.', template: '%s | nanosync' },
  description: 'Self-hosted, client-encrypted file synchronization for ordinary Linux folders.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><div className="site-container">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><Link className="brand" href="/">nanosync</Link><nav aria-label="Main"><Link href="/">home</Link><Link href="/docs">docs</Link><Link href="/pricing">pricing</Link><Link href="/dashboard">dashboard</Link><a href="https://github.com/FireSquid6/nanosync">source ↗</a></nav></header>
    {children}
    <footer className="site-footer"><span>nanosync · files on your machines.</span><ThemeControl /></footer>
  </div></body></html>;
}

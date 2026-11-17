import Link from 'next/link';
export default function NotFound() {
  return <main id="main" className="home-main"><h1>Page not found</h1><p>Try the <Link href="/docs">documentation</Link> or <Link href="/">home page</Link>.</p></main>;
}

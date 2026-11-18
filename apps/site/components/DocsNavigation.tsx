'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { createDocSearch, type SearchDocument } from '../lib/search';

export function DocsNavigation({ documents }: { documents: SearchDocument[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useMemo(() => createDocSearch(documents), [documents]);
  const results = search(query);
  function close() {
    setOpen(false);
    setQuery('');
    document.getElementById('doc-content')?.focus();
  }
  return <aside className="docs-sidebar">
    <button className="browse-button" aria-expanded={open} aria-controls="docs-navigation" onClick={() => setOpen(!open)}>Browse documentation</button>
    <div id="docs-navigation" className={open ? 'sidebar-content open' : 'sidebar-content'}>
      <form role="search" onSubmit={event => event.preventDefault()}>
        <label htmlFor="docs-search">Search documentation</label>
        <input id="docs-search" type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
      </form>
      {query.trim() ? <section aria-label="Search results">
        <p role="status">{results.length} results</p>
        <ul>{results.map(doc => <li key={doc.slug}><Link onClick={close} href={`/docs/${doc.slug}`}>{doc.title}</Link></li>)}</ul>
      </section> : <nav aria-label="Documentation"><p className="sidebar-label">Field guide</p><ul>{documents.map(doc => <li key={doc.slug}><Link href={`/docs/${doc.slug}`} onClick={close} aria-current={pathname === `/docs/${doc.slug}` ? 'page' : undefined}>{doc.title}</Link></li>)}</ul></nav>}
    </div>
  </aside>;
}

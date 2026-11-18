import { getDocs } from '../../lib/docs';
import { DocsNavigation } from '../../components/DocsNavigation';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <main id="main" className="docs-main"><DocsNavigation documents={getDocs()} /><div id="doc-content" className="docs-article" tabIndex={-1}>{children}</div></main>;
}

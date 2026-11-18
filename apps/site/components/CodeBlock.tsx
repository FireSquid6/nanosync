'use client';

import { useRef, useState, type ComponentPropsWithoutRef } from 'react';

export function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(ref.current?.textContent ?? '');
      setStatus('Copied');
    } catch { setStatus('Copy failed; select the code to copy it.'); }
  }
  return <div className="code-block"><pre ref={ref} tabIndex={0} {...props}>{children}</pre><div className="copy-row"><button onClick={copy} aria-label="Copy code">Copy</button><span role="status">{status}</span></div></div>;
}

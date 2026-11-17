'use client';

import { useEffect, useId, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>('system');
  const id = useId();
  useEffect(() => {
    try {
      const saved = localStorage.getItem('nanosync-theme');
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        setTheme(saved);
        if (saved === 'system') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = saved;
      }
    } catch { /* Storage may be disabled; the system theme still works. */ }
  }, []);
  function change(value: Theme) {
    setTheme(value);
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    try { localStorage.setItem('nanosync-theme', value); } catch { /* Keep the in-memory choice. */ }
  }
  return <div className="theme-control"><label htmlFor={id}>Theme</label><select id={id} value={theme} onChange={event => change(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>;
}

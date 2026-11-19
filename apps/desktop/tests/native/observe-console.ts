// Fixture observation only: preserve original console calls; never redact or replace their arguments.
export const observeConsole = `(() => {
  window.__fixtureLogs = [];
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      window.__fixtureLogs.push(args.map(value => value instanceof Error ? String(value) : typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
      original(...args);
    };
  }
})();`;

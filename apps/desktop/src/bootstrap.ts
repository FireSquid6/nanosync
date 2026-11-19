import { verifyPackagedRuntime } from './verify-runtime';
try {
  verifyPackagedRuntime();
  // Scope the validated GTK X11/XWayland profile to this app before SDK initialization.
  if (process.platform === 'linux') process.env.GDK_BACKEND = 'x11';
  await import('./main');
} catch {
  console.error('DESKTOP_SDK_GATE_FAILED');
  process.exit(1);
}

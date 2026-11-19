import { verifyPackagedRuntime } from './verify-runtime';
try {
  verifyPackagedRuntime();
  await import('./main');
} catch {
  console.error('DESKTOP_SDK_GATE_FAILED');
  process.exit(1);
}

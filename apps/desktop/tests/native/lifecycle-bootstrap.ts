import { verifyPackagedRuntime } from '../../src/verify-runtime';
verifyPackagedRuntime();
process.env.GDK_BACKEND = 'x11';
await import('./lifecycle-main');

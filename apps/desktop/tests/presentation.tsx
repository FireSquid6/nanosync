// Browser presentation harness only; never a packaged entrypoint or native credential provider.
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import type { DesktopCommand, DesktopReply } from '../src/rpc';
import '../../../packages/ui-theme/styles.css';
import '../../../packages/admin-ui/src/paper/styles.css';
import '../src/styles.css';

declare global {
  interface Window {
    desktopPresentation(command: DesktopCommand): Promise<DesktopReply>;
  }
}
createRoot(document.getElementById('root')!).render(
  <App send={(command) => window.desktopPresentation(command)} />,
);

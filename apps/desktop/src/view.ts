import { Electroview } from 'electrobun/view';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopRPC } from './rpc';
import { App } from './App';
import '../../../packages/ui-theme/styles.css';
import '../../../packages/admin-ui/src/paper/styles.css';
import './styles.css';

const rpc = Electroview.defineRPC<DesktopRPC>({ maxRequestTime: Infinity, handlers: {} });
new Electroview({ rpc });
createRoot(document.getElementById('root')!).render(createElement(App, { send: command => rpc.request.client(command) }));

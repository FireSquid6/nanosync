import type { ClientSnapshot, DesktopRPC, FolderSummary, Result } from '../shared/rpc.ts';

export const escapeHTML = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const esc = escapeHTML;
const status = (f: FolderSummary) => `<span class="status"><span aria-hidden="true" class="symbol ${f.status === 'Up to date' ? 'ok' : f.status === 'Syncing' ? 'work' : 'attn'}"></span>${esc(f.status)}</span>`;
export function folderCard(f: FolderSummary, selected: string) {
  return `<article class="folder ${f.id === selected ? 'selected' : ''}" data-folder="${esc(f.id)}">
<div class="foldertop"><button class="name" data-folder="${esc(f.id)}" aria-pressed="${f.id === selected}">${esc(f.name)}</button>${status(f)}</div>
<div class="path">${esc(f.path)}</div><div class="meta"><span>${esc(f.serverName)} / ${esc(f.vaultId)}</span><span>Owned by ${esc(f.owner ?? 'Nobody')}</span></div>
${f.progress ? `<p class="small" role="status">${esc(f.progress)}</p>` : ''}${f.error ? `<p class="error">${esc(f.error)}</p>` : ''}</article>`;
}

type Transport = {
  request: {
    snapshot(): Promise<Result<ClientSnapshot>>;
    sync(params: { id: string }): Promise<Result>;
    migrate(params: { id: string }): Promise<Result>;
    quit(): Promise<Result>;
  };
};

export function mountLive(rpc: Transport) {
  let state: ClientSnapshot = { servers: [], folders: [] };
  let loaded = false;
  let selected = '';
  let view = 'folders';
  let refreshing = false;
  const pending = new Set<string>();
  const content = document.querySelector<HTMLElement>('#content')!;
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  const notice = document.querySelector<HTMLElement>('#notice')!;
  const message = (text: string) => { notice.textContent = text; notice.hidden = !text; };
  const update = (snapshot: ClientSnapshot) => {
    state = snapshot;
    loaded = true;
    if (!state.folders.some(f => f.id === selected)) selected = state.folders[0]?.id ?? '';
    render();
  };
  function render() {
    const focused = document.activeElement as HTMLElement | null;
    const focusFolder = focused?.dataset['folder'];
    const focusAction = focused?.dataset['act'];
    for (const nav of document.querySelectorAll<HTMLElement>('[data-nav]')) {
      if (nav.dataset['nav'] === view) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
    const f = state.folders.find(item => item.id === selected);
    content.innerHTML = `<div class="pagehead"><h1>${view === 'folders' ? 'Folders' : 'Connections'}</h1><button data-act="refresh" ${refreshing ? 'disabled' : ''}>Refresh</button></div>` +
      (!loaded ? '<p>Loading client state…</p>' : view === 'folders' ?
        (state.folders.length ? `<div class="workspace"><section aria-label="Connected folders"><div class="listhead">${state.folders.length} folders</div>${state.folders.map(folder => folderCard(folder, selected)).join('')}</section>
<section class="inspector" aria-label="Selected folder"><h2>${esc(f!.name)}</h2><p class="path">${esc(f!.path)}</p><div class="actions"><button data-act="sync" ${pending.has(f!.id) || f!.status === 'Syncing' ? 'disabled' : ''}>Sync now</button></div><dl class="kv">
${[['Server', f!.serverName], ['Vault', f!.vaultId], ['Sync owner', f!.owner ?? 'Nobody'], ['Status', f!.status], ['Last successful sync', f!.lastSync ?? 'Never'], ['Sequence', f!.sequence ?? 'Not checked'], ['Conflicts', f!.conflicts]].map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
${f!.progress ? `<p role="status">${esc(f!.progress)}</p>` : ''}${f!.error ? `<p class="error">${esc(f!.error)}</p>` : ''}</section></div>` : '<p>No connected folders. Enroll a folder with the nanosync CLI, then refresh.</p>') :
        (state.servers.length ? `<div class="textcol">${state.servers.map(s => `<section class="conflict"><h2>${esc(s.name)}</h2><p class="path">${esc(s.url)}</p><p>Credentials: ${s.credentialMode === 'os' ? 'OS store' : 'Protected file'}</p>${s.credentialMode === 'protected-file' || s.migrationPending ? `<button data-migrate="${esc(s.id)}" ${pending.has(s.id) ? 'disabled' : ''}>Migrate credentials to OS store</button>` : ''}</section>`).join('')}</div>` : '<p>No connections. Enroll with the nanosync CLI, then refresh.</p>'));
    if (focused && content.contains(focused)) return;
    if (focusFolder) [...content.querySelectorAll<HTMLElement>('button[data-folder]')].find(el => el.dataset['folder'] === focusFolder)?.focus();
    else if (focusAction) [...content.querySelectorAll<HTMLElement>('[data-act]')].find(el => el.dataset['act'] === focusAction)?.focus();
  }
  async function refresh(manual = false) {
    if (refreshing) return;
    refreshing = true;
    if (manual) { message(''); render(); }
    try {
      const result = await rpc.request.snapshot();
      if (result.ok) update(result.value);
      else message(result.error);
    } catch { message('Unable to reach the desktop service. Try refreshing.'); }
    finally { refreshing = false; render(); }
  }
  async function operation(kind: 'sync' | 'migrate', id: string) {
    if (pending.has(id)) return;
    pending.add(id); message(''); render();
    try {
      const result = await rpc.request[kind]({ id });
      if (!result.ok) message(result.error);
    } catch { message('The operation could not complete. Refresh to check its current state.'); }
    finally { pending.delete(id); await refresh(); }
  }
  let returnFocus: HTMLElement | null = null;
  const click = (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLElement>('button, [data-folder]');
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
    const nav = target.dataset['nav'];
    if (nav) { view = nav; render(); content.focus(); return; }
    const folder = target.dataset['folder'];
    if (folder) { selected = folder; render(); return; }
    const serverId = target.dataset['migrate'];
    if (serverId) {
      const server = state.servers.find(s => s.id === serverId);
      if (!server) return;
      returnFocus = target;
      dialog.innerHTML = `<h2 id="dialog-title">Migrate credentials to OS store</h2><p>Move credentials for ${esc(server.name)} from the protected file to your OS credential store?</p><p>Headless CLI use may stop working when the OS store is locked or unavailable. Unlocking requires your desktop session. There is no plaintext fallback.</p><div class="actions"><button data-act="cancel">Cancel</button><button data-confirm="${esc(serverId)}">Confirm migration</button></div>`;
      dialog.showModal(); return;
    }
    if (target.dataset['confirm']) { dialog.close(); void operation('migrate', target.dataset['confirm']); return; }
    switch (target.dataset['act']) {
      case 'cancel': dialog.close(); break;
      case 'refresh': void refresh(true); break;
      case 'sync': if (selected) void operation('sync', selected); break;
      case 'quit':
        target.setAttribute('disabled', '');
        void rpc.request.quit().then(result => { if (!result.ok) message(result.error); }).catch(() => message('Unable to quit safely. Try again.')).finally(() => target.removeAttribute('disabled'));
        break;
    }
  };
  const onClose = () => { if (returnFocus?.isConnected) returnFocus.focus(); else content.focus(); };
  document.addEventListener('click', click);
  dialog.addEventListener('close', onClose);
  void refresh();
  const poll = setInterval(() => { void refresh(); }, 3000);
  return { update, dispose: () => { clearInterval(poll); document.removeEventListener('click', click); dialog.removeEventListener('close', onClose); } };
}

if (typeof document !== 'undefined') {
  const { Electroview } = await import('electrobun/view');
  let ui: ReturnType<typeof mountLive> | undefined;
  let initialPush: ClientSnapshot | undefined;
  const rpc = Electroview.defineRPC<DesktopRPC>({
    maxRequestTime: Infinity,
    handlers: { messages: { snapshotChanged: snapshot => {
      if (ui) ui.update(snapshot);
      else initialPush = snapshot;
    } } },
  });
  new Electroview({ rpc });
  ui = mountLive(rpc.proxy);
  if (initialPush) ui.update(initialPush);
}

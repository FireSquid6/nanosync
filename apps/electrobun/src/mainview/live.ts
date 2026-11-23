import type { ClientSnapshot, DesktopRPC, FolderSummary, EnrollmentSummary, VaultSummary, Result } from '../shared/rpc.ts';

export const escapeHTML = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const esc = escapeHTML;
const status = (f: FolderSummary) => `<span class="status"><span aria-hidden="true" class="symbol ${f.status === 'Up to date' ? 'ok' : f.status === 'Syncing' ? 'work' : 'attn'}"></span>${esc(f.status)}</span>`;
export function folderCard(f: FolderSummary, selected: string) {
  return `<article class="folder ${f.id === selected ? 'selected' : ''}" data-folder="${esc(f.id)}">
<div class="foldertop"><button class="name" data-folder="${esc(f.id)}" aria-pressed="${f.id === selected}">${esc(f.name)}</button>${status(f)}</div>
<div class="path">${esc(f.path)}</div><div class="meta"><span>${esc(f.serverName)} / ${esc(f.vaultId)}</span><span>Owned by ${esc(f.owner ?? 'Nobody')}</span></div>
${f.progress ? `<p class="small" role="status">${esc(f.progress)}</p>` : ''}${f.error ? `<p class="error">${esc(f.error)}</p>` : ''}</article>`;
}

type Requests = DesktopRPC['bun']['requests'];
type Transport = { request: { [K in keyof Requests]: (...args: Requests[K]['params'] extends undefined ? [] : [Requests[K]['params']]) => Promise<Requests[K]['response']> } };

export function mountLive(rpc: Transport) {
  let state: ClientSnapshot = { servers: [], folders: [] };
  let loaded = false;
  let enrollments: EnrollmentSummary[] = [];
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
    content.innerHTML = `<div class="pagehead"><h1>${view === 'folders' ? 'Folders' : 'Connections'}</h1><div class="actions"><button data-act="${view === 'folders' ? 'connect' : 'add'}">${view === 'folders' ? 'Connect folder' : 'Add connection'}</button><button data-act="refresh" ${refreshing ? 'disabled' : ''}>Refresh</button></div></div>` +
      (!loaded ? '<p>Loading client state…</p>' : view === 'folders' ?
        (state.folders.length ? `<div class="workspace"><section aria-label="Connected folders"><div class="listhead">${state.folders.length} folders</div>${state.folders.map(folder => folderCard(folder, selected)).join('')}</section>
<section class="inspector" aria-label="Selected folder"><h2>${esc(f!.name)}</h2><p class="path">${esc(f!.path)}</p><div class="actions"><button data-act="sync" ${pending.has(f!.id) || f!.status === 'Syncing' ? 'disabled' : ''}>Sync now</button></div><dl class="kv">
${[['Server', f!.serverName], ['Vault', f!.vaultId], ['Sync owner', f!.owner ?? 'Nobody'], ['Status', f!.status], ['Last successful sync', f!.lastSync ?? 'Never'], ['Sequence', f!.sequence ?? 'Not checked'], ['Conflicts', f!.conflicts]].map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
${f!.progress ? `<p role="status">${esc(f!.progress)}</p>` : ''}${f!.error ? `<p class="error">${esc(f!.error)}</p>` : ''}</section></div>` : '<p>No connected folders. Connect a folder to an existing vault.</p>') :
        (state.servers.length ? `<div class="textcol">${state.servers.map(s => `<section class="conflict" data-connect="${esc(s.id)}"><h2>${esc(s.name)}</h2><button data-connect="${esc(s.id)}">Connect folder</button><p class="path">${esc(s.url)}</p><p>Credentials: ${s.credentialMode === 'os' ? 'OS store' : 'Protected file'}</p>${s.credentialMode === 'protected-file' || s.migrationPending ? `<button data-migrate="${esc(s.id)}" ${pending.has(s.id) ? 'disabled' : ''}>Migrate credentials to OS store</button>` : ''}</section>`).join('')}</div>` : '<p>No connections.</p>') + enrollments.filter(e => e.status !== 'approved').map(e => `<section class="conflict" data-enrollment="${esc(e.id)}"><button data-enrollment="${esc(e.id)}">${esc(e.alias)} — ${esc(e.status)}</button></section>`).join(''));
    if (focused && content.contains(focused)) return;
    if (focusFolder) [...content.querySelectorAll<HTMLElement>('button[data-folder]')].find(el => el.dataset['folder'] === focusFolder)?.focus();
    else if (focusAction) [...content.querySelectorAll<HTMLElement>('[data-act]')].find(el => el.dataset['act'] === focusAction)?.focus();
  }
  async function refresh(manual = false) {
    if (refreshing) return;
    refreshing = true;
    if (manual) { message(''); render(); void loadEnrollments(); }
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
  // Snapshot polling only replaces main content, never the active form or its secrets.
  let setupVersion = 0;
  let draft = { url: '', alias: '', deviceName: '' };
  function openSetup(target: HTMLElement) {
    returnFocus = target;
    setupVersion++;
    if (!dialog.open) dialog.showModal();
  }
  function screen(title: string, body: string) {
    dialog.innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><p class="error" role="alert" data-setup-error hidden style="overflow-wrap:anywhere"></p>${body}`;
    dialog.querySelector<HTMLElement>('input, select, button')?.focus();
  }
  function setupError(text: string) {
    const el = dialog.querySelector<HTMLElement>('[data-setup-error]');
    if (el) { el.textContent = text; el.hidden = false; }
  }
  async function call<T>(work: () => Promise<Result<T>>, next: (value: T) => void | Promise<void>, retry?: () => void) {
    const version = setupVersion;
    const focused = document.activeElement as HTMLElement | null;
    const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')].map(el => ({ el, disabled: el.disabled }));
    controls.forEach(({ el }) => el.disabled = true);
    try {
      const result = await work();
      if (version !== setupVersion || !dialog.open) return;
      if (result.ok) await next(result.value); else { retry?.(); setupError(result.error); }
    } catch { if (version === setupVersion && dialog.open) { retry?.(); setupError('Unable to reach the desktop service. Please try again.'); } }
    finally {
      controls.forEach(({ el, disabled }) => el.disabled = disabled);
      if (version === setupVersion && dialog.open && focused?.isConnected && dialog.contains(focused)) focused.focus();
    }
  }
  async function loadEnrollments() {
    try {
      const result = await rpc.request.listEnrollments();
      if (result.ok) { enrollments = result.value; render(); } else message(result.error);
    } catch { message('Unable to load pending connections. Refresh to try again.'); }
  }
  const field = (label: string, name: string, value = '', type = 'text', required = true) => `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} autocomplete="off"></label>`;
  const cancel = '<button type="button" data-act="cancel">Cancel</button>';
  function enrollmentForm(fresh = false) {
    screen(fresh ? 'Request fresh enrollment' : 'Add connection', `<form>${field('Server URL', 'url', draft.url, 'url')}${field('Alias', 'alias', draft.alias)}${field('Device name', 'deviceName', draft.deviceName)}${field('Password', 'password', '', 'password')}<div class="actions">${cancel}<button class="primary">Request enrollment</button></div></form>`);
    const form = dialog.querySelector('form')!;
    form.oninput = () => { draft = { url: (form.elements.namedItem('url') as HTMLInputElement).value, alias: (form.elements.namedItem('alias') as HTMLInputElement).value, deviceName: (form.elements.namedItem('deviceName') as HTMLInputElement).value }; };
    form.onsubmit = event => {
      event.preventDefault();
      const password = form.elements.namedItem('password') as HTMLInputElement;
      const params = { ...draft, ...(password.value ? { password: password.value } : {}), ...(fresh ? { fresh: true } : {}) };
      password.value = '';
      password.closest('label')!.remove();
      void call(() => rpc.request.enroll(params), e => { enrollments = [...enrollments.filter(item => item.id !== e.id), e]; render(); enrollmentView(e); }, () => enrollmentForm(fresh));
    };
  }
  function enrollmentView(e: EnrollmentSummary) {
    screen('Connection approval', `<p>${esc(e.alias)} — ${esc(e.status)}</p>${e.verificationCode ? `<p>Verification code: <strong>${esc(e.verificationCode)}</strong></p>` : ''}${e.error ? `<p class="error" style="overflow-wrap:anywhere">${esc(e.error)}</p>` : ''}${e.status === 'pending' ? `<p>Waiting for approval. Verify this code with your server operator.</p>${e.adminUrl ? '<button data-admin>Open administration</button>' : '<p>Contact your server operator to approve this device.</p>'}` : ''}<div class="actions"><button data-act="cancel">Done</button>${e.status === 'approved' ? '<button data-vaults>Connect folder</button>' : '<button data-check>Check approval</button>'}${e.status === 'error' ? '<button data-resume>Retry enrollment</button>' : ''}${e.status === 'denied' || e.status === 'expired' ? '<button data-fresh>Request fresh enrollment</button>' : ''}</div>`);
    dialog.querySelector<HTMLButtonElement>('[data-admin]')?.addEventListener('click', () => { void call(() => rpc.request.openAdministration({ id: e.id }), () => {}); });
    dialog.querySelector<HTMLButtonElement>('[data-check]')?.addEventListener('click', () => { void call(() => rpc.request.checkEnrollment({ id: e.id }), updated => { enrollments = enrollments.map(item => item.id === updated.id ? updated : item); render(); enrollmentView(updated); void refresh(); }); });
    dialog.querySelector<HTMLButtonElement>('[data-resume]')?.addEventListener('click', () => { draft = { url: e.url, alias: e.alias, deviceName: e.deviceName }; enrollmentForm(); });
    dialog.querySelector<HTMLButtonElement>('[data-fresh]')?.addEventListener('click', () => { draft = { url: e.url, alias: e.alias, deviceName: e.deviceName }; enrollmentForm(true); });
    dialog.querySelector<HTMLButtonElement>('[data-vaults]')?.addEventListener('click', () => { void vaultForm(e.id); });
  }
  function serverForm() {
    screen('Connect folder', `<form><label class="field">Server<select name="server" required><option value="">Choose a server</option>${state.servers.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${s.credentialMode === 'os' ? 'OS store' : 'Protected file'})</option>`).join('')}</select></label><p>Protected-file credentials are not converted. Migration is available on Connections.</p><div class="actions">${cancel}<button>Choose vault</button><button type="button" data-new>Add connection</button></div></form>`);
    dialog.querySelector('form')!.onsubmit = event => { event.preventDefault(); void vaultForm((dialog.querySelector('select') as HTMLSelectElement).value); };
    dialog.querySelector('[data-new]')!.addEventListener('click', () => enrollmentForm());
  }
  async function vaultForm(serverId: string) {
    screen('Connect folder', `<p role="status">Loading vaults…</p>${cancel}<button data-retry>Retry</button>`);
    dialog.querySelector('[data-retry]')!.addEventListener('click', () => { void vaultForm(serverId); });
    await call(() => rpc.request.listVaults({ id: serverId }), vaults => folderForm(serverId, vaults));
  }
  function folderForm(serverId: string, vaults: VaultSummary[]) {
    screen('Connect folder', `<form>${vaults.length ? '' : '<p>No vaults available. Contact your server operator.</p>'}<label class="field">Vault<select name="vault" required><option value="">Choose a vault</option>${vaults.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label><div data-key></div>${field('Folder path (absolute)', 'path')}<button type="button" data-choose>Choose folder</button><p>Local and remote contents will be reconciled when you start syncing. Conflicting versions are preserved; existing files are not treated as remote deletions. We have not checked whether this folder is empty.</p><label class="check"><input type="checkbox" name="consent" required>I understand and allow connecting a folder that may contain files.</label><div class="actions">${cancel}<button class="primary" ${vaults.length ? '' : 'disabled'}>Connect</button></div></form>`);
    const form = dialog.querySelector('form')!;
    const vault = form.elements.namedItem('vault') as HTMLSelectElement;
    vault.onchange = () => { dialog.querySelector('[data-key]')!.innerHTML = vaults.find(v => v.id === vault.value)?.needsRecoveryKey ? field('Recovery key', 'recoveryKey', '', 'password') : ''; };
    dialog.querySelector('[data-choose]')!.addEventListener('click', () => { void call(() => rpc.request.chooseFolder(), path => { if (path) (form.elements.namedItem('path') as HTMLInputElement).value = path; }); });
    form.onsubmit = event => {
      event.preventDefault();
      const key = form.elements.namedItem('recoveryKey') as HTMLInputElement | null;
      const params = { serverId, vaultId: vault.value, path: (form.elements.namedItem('path') as HTMLInputElement).value, confirmNonempty: (form.elements.namedItem('consent') as HTMLInputElement).checked, ...(key?.value ? { recoveryKey: key.value } : {}) };
      if (key) { key.value = ''; key.closest('label')!.remove(); }
      const version = setupVersion;
      void call(() => rpc.request.connectFolder(params), async binding => {
        await refresh();
        if (version !== setupVersion || !dialog.open) return;
        if (state.folders.some(f => f.id === binding.id)) { selected = binding.id; render(); }
        screen('Folder connected', '<p>No files have been transferred.</p><div class="actions"><button data-act="cancel">Done</button><button data-start>Start syncing</button></div>');
        dialog.querySelector('[data-start]')!.addEventListener('click', () => { dialog.close(); void operation('sync', binding.id); });
      }, () => { if (key) dialog.querySelector('[data-key]')!.innerHTML = field('Recovery key', 'recoveryKey', '', 'password'); });
    };
  }
  let returnFocus: HTMLElement | null = null;
  const click = (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLElement>('button, [data-folder], [data-connect], [data-enrollment]');
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
    if (target.dataset['connect']) { openSetup(target); void vaultForm(target.dataset['connect']); return; }
    if (target.dataset['enrollment']) { const e = enrollments.find(e => e.id === target.dataset['enrollment']); if (e) { openSetup(target); enrollmentView(e); } return; }
    if (target.dataset['confirm']) { dialog.close(); void operation('migrate', target.dataset['confirm']); return; }
    switch (target.dataset['act']) {
      case 'add': openSetup(target); enrollmentForm(); break;
      case 'connect': openSetup(target); serverForm(); break;
      case 'cancel': dialog.close(); break;
      case 'refresh': void refresh(true); break;
      case 'sync': if (selected) void operation('sync', selected); break;
      case 'quit':
        target.setAttribute('disabled', '');
        void rpc.request.quit().then(result => { if (!result.ok) message(result.error); }).catch(() => message('Unable to quit safely. Try again.')).finally(() => target.removeAttribute('disabled'));
        break;
    }
  };
  const onClose = () => { setupVersion++; dialog.innerHTML = '';  if (returnFocus?.isConnected) returnFocus.focus(); else {
    const replacement = [...content.querySelectorAll<HTMLElement>('button')].find(el => ['act', 'connect', 'migrate', 'enrollment'].some(key => returnFocus?.dataset[key] && el.dataset[key] === returnFocus.dataset[key]));
    (replacement ?? content).focus();
  } };
  document.addEventListener('click', click);
  dialog.addEventListener('close', onClose);
  void refresh();
  void loadEnrollments();
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

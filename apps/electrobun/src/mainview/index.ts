import { IgnoreMatcher } from "../../../../packages/sync-core/src/ignore.ts";
import {
  STORAGE_KEY,
  loadState,
  folderStatus,
  normalizePath,
  overlaps,
} from "./mock.ts";
import type { Folder, Enrollment } from "./mock.ts";

const state = loadState();
let view = "folders";
let selected = state.folders[0]?.id || "";
let tab = "general";
let validated: string | null = null;
let connectionId = "";
let resolving = "";
let returnFocus: HTMLElement | null = null;
const content = document.querySelector<HTMLElement>("#content")!;
const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
const toast = document.querySelector<HTMLElement>(".toast")!;
const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const button = (label: string, action: string, cls = "") =>
  `<button class="${cls}" data-act="${action}">${label}</button>`;
const head = (title: string, description: string, actions = "") =>
  `<div class="pagehead">
<div>
<h1>${title}</h1>
${description ? `<p>${description}</p>` : ""}
</div>
<div class="actions">${actions}</div>
</div>`;
const check = (id: string, label: string, checked: boolean, disabled = false) =>
  `<label class="check">
<input type="checkbox" id="${id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
<span>${label}</span>
</label>`;
const field = (id: string, label: string, value: string, type = "text") =>
  `<label class="field">${label}<input id="${id}" type="${type}" value="${esc(value)}" ${type === "password" ? 'autocomplete="off"' : ""}>
</label>`;
const value = (id: string) =>
  (document.getElementById(id) as HTMLInputElement).value;
const checked = (id: string) =>
  (document.getElementById(id) as HTMLInputElement).checked;
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    notify(
      "Browser storage unavailable. Changes will not survive a restart.",
    );
  }
}
function notify(message: string) {
  toast.textContent = message;
  toast.hidden = false;
}
function modal(title: string, body: string) {
  returnFocus = document.activeElement as HTMLElement;
  dialog.innerHTML = `<h2 id="dialog-title">${title}</h2>${body}<p id="dialog-error" role="alert" class="error">
</p>`;
  dialog.showModal();
}
function close() {
  dialog.close();
}
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  if (returnFocus?.isConnected && !dialog.contains(returnFocus)) {
    returnFocus.focus();
    return;
  }
  const action = returnFocus?.dataset["act"];
  const replacement =
    action &&
    [...document.querySelectorAll<HTMLElement>("[data-act]")].find(
      (el) => !dialog.contains(el) && el.dataset["act"] === action,
    );
  (replacement || content).focus();
});
function error(message: string) {
  const target = dialog.open
    ? dialog.querySelector("#dialog-error")
    : content.querySelector("#form-error");
  if (target) target.textContent = message;
}
function folder(): Folder {
  return state.folders.find((f) => f.id === selected) || state.folders[0]!;
}
function go(next: string) {
  view = next;
  render();
  content.focus();
}
function status(label: string) {
  return `<span class="status">
<span aria-hidden="true" class="symbol ${label === "Paused" ? "pause" : label === "Up to date" ? "ok" : label === "Syncing" ? "work" : "attn"}">
</span>${esc(label)}</span>`;
}
function lifecycle() {
  return (
    check("startAtLogin", "Start at user login", state.settings.startAtLogin) +
    check(
      "background",
      "Keep syncing after closing the window",
      state.settings.background,
    ) +
    `<p class="note">Startup is opt-in, after user login only. Background on: closing hides the window; login starts hidden. Background off: closing exits and login opens a window. Reopen from the launcher. Logout stops desktop syncing. Independently CLI-owned sync is unaffected by desktop Quit.</p>`
  );
}
function foldersView() {
  const f = folder();
  return (
    (state.enrollment
      ? `<div class="notice">
<p>Saved enrollment: ${esc(state.enrollment.status)}</p>${button("Resume enrollment", "resume-enrollment")}</div>`
      : "") +
    head(
      "Folders",
      "",
      button("Connect folder", "connect", "primary") +
        button(
          state.globalPaused ? "Resume globally" : "Pause globally",
          "global",
        ),
    ) +
    (state.globalPaused
      ? `<div class="notice">Global pause is on. New work stops in both directions at a safe filesystem boundary. Individually paused folders stay paused after global resume.</div>`
      : `<div class="notice">${state.conflicts.length} unresolved conflicts</div>`) +
    `<div class="workspace">
<section aria-label="Connected folders">
<div class="listhead">${state.folders.length} local copies · sync owner shown per folder</div>${state.folders
      .map(
        (x) => `<article class="folder ${x.id === selected ? "selected" : ""}" data-folder="${esc(x.id)}">
<div class="foldertop">
<button class="name" data-folder="${esc(x.id)}" aria-pressed="${x.id === selected}">${esc(x.name)}</button>${status(folderStatus(state, x))}</div>
<div class="path">${esc(x.path)}</div>
<div class="meta">
<span>${esc(x.server)} / ${esc(x.vault)}</span>
<span>Owned by ${x.owner}</span>
</div>${
          folderStatus(state, x) === "Syncing"
            ? `<progress max="19" value="12" aria-label="Transfer progress">12 of 19 files</progress>
<p class="small">12 of 19 files · 18.4 MiB remaining</p>`
            : ""
        }</article>`,
      )
      .join(
        "",
      )}<p class="note">“Up to date” means observed local changes published, latest checked remote state applied, and no transfers or unresolved conflicts. Last successful sync is separate.</p>
</section>${
      f
        ? `<section class="inspector" aria-label="Selected folder">
<h2>${esc(f.name)}</h2>
<p class="path">${esc(f.path)}</p>
<div class="actions">${button("Open folder", "open")}${button("Sync now", "sync")}${button(f.paused ? "Resume folder" : "Pause folder", "pause")}</div>
<dl class="kv">
<div>
<dt>Server / vault</dt>
<dd>${esc(f.server)} / ${esc(f.vault)}</dd>
</div>
<div>
<dt>Sync owner</dt>
<dd>${f.owner}</dd>
</div>
<div>
<dt>Last successful sync</dt>
<dd>${esc(f.last)}</dd>
</div>
<div>
<dt>Pending work</dt>
<dd>${f.pending} items</dd>
</div>
</dl>
<div class="rule">
<h3>${esc(folderStatus(state, f))}</h3>${detail(f)}</div>
<div class="rule">${button("Edit ignore rules", "ignores")}${button("Disconnect folder", "disconnect")}</div>
${f.owner === "CLI" ? '<p class="note">Desktop Quit leaves CLI syncing running.</p>' : ""}
</section>`
        : `<p>No connected folders. Connect a folder to begin.</p>`
    }</div>`
  );
}
function detail(f: Folder) {
  const label = folderStatus(state, f);
  if (label === "Folder unavailable")
    return `<p>Connected root is missing. Sync stopped; state preserved. Missing contents are never treated as deletions. No automatic recreation.</p>${button("Retry folder", "retry")}`;
  if (label === "Credentials locked")
    return `<p>Unlock the OS credential store. No plaintext fallback; your OS password is never requested here.</p>${button("Unlock credentials", "unlock")}`;
  if (label === "Migration decision required")
    return button("Review credential mode", "credential");
  if (label === "Conflicts")
    return `<p>Both versions preserved. Resolve manually in your own editor.</p>${button("Review conflicts", "conflicts")}`;
  if (label === "Access revoked")
    return `<p>Access revoked. Files preserved. Contact the operator or enroll again.</p>${button("Reconnect device", "connect")}`;
  if (label === "Offline")
    return `<p>Server unreachable. Local editing available. Brief outages do not trigger notifications.</p>${button("Retry connection", "retry")}`;
  if (label === "Paused")
    return `<p>New work in both directions paused. In-progress filesystem operations reach a safe stopping point. ${f.paused ? "This folder remains paused when global pause is removed." : "This folder can continue after global resume."}</p>`;
  return label === "Up to date"
    ? "<p>No pending transfers or unresolved conflicts.</p>"
    : "";
}
function conflictsView() {
  return (
    head(
      "Conflicts",
      "Nothing discarded. Review preserved copies in your own editor.",
    ) +
    `<div class="textcol">
<p>Compare and merge manually, save your intended result, then acknowledge resolution. This app never chooses a version or deletes a preserved copy.</p>${
      state.conflicts
        .map(
          (c) => `<section class="conflict">
<h2>${esc(c.file)}</h2>
<p>Working file: ${esc(c.file)}<br>Preserved copy: ${esc(c.copy)}</p>
<div class="actions">${button("Open containing folder", "open")}${button("I have resolved this", `resolve:${c.id}`)}</div>
</section>`,
        )
        .join("") || "<p>No unresolved conflicts.</p>"
    }</div>`
  );
}
function connectionsView() {
  return (
    head(
      "Connections",
      "",
      button("Add connection", "connect", "primary"),
    ) +
    `<table class="table">
<thead>
<tr>
<th>Server</th>
<th>Credential mode</th>
<th>Actions</th>
</tr>
</thead>
<tbody>${state.connections
      .map(
        (c) => `<tr>
<td>
<strong>${esc(c.name)}</strong>
<br>${esc(c.url)}</td>
<td>${c.credential === "os" ? "OS credential store" : c.credential === "locked" ? "Credentials locked" : "Protected-file · headless CLI"}</td>
<td>${button(`Details: ${esc(c.name)}`, `connection:${c.id}`)}</td>
</tr>`,
      )
      .join("")}</tbody>
</table>
<p class="note">Server setup, vault creation and device approval stay external.</p>`
  );
}
function settingsView() {
  return (
    head(
      "Settings",
      "",
    ) +
    `<nav class="subnav" aria-label="Settings categories">${["general", "notifications", "diagnostics"].map((t) => `<button data-tab="${t}" ${tab === t ? 'aria-current="page"' : ""}>${t[0]!.toUpperCase() + t.slice(1)}</button>`).join("")}</nav>
<div class="textcol">${
      tab === "general"
        ? `<h2>Window & startup</h2>${lifecycle()}<label class="field">Appearance<select id="theme">${["system", "light", "dark"].map((t) => `<option ${state.settings.theme === t ? "selected" : ""}>${t}</option>`).join("")}</select>
</label>
`
        : tab === "notifications"
          ? `<h2>Only when something needs you</h2>${check("notifications", "Enable notifications", state.settings.notifications)}${check("conflicts", "Conflicts", state.settings.conflicts, !state.settings.notifications)}${check("revoked", "Revoked access", state.settings.revoked, !state.settings.notifications)}${check("failures", "Persistent failures", state.settings.failures, !state.settings.notifications)}${check("includePaths", "Include filenames and paths in notifications", state.settings.includePaths)}<p>Private by default. Repeated alerts are deduplicated; actionable details remain in the app. No ordinary success or brief outage alerts.</p>`
          : `<h2>Export diagnostics</h2>
<p>Explicit export only, never uploaded. Excludes credentials, passwords, keys, recovery material, file contents, filenames and paths.</p>${button("Review diagnostic report", "diagnostics", "primary")}`
    }</div>`
  );
}
function enrollment(): Enrollment {
  return state.enrollment!;
}
function wizardView() {
  const e = enrollment();
  if (!e)
    return head(
      "Connect folder",
      "Setup cancelled.",
      button("Start setup", "connect"),
    );
  let body = "";
  if (e.step === 0)
    body = `<h2>Connect to your server</h2>
<label class="field">Server connection<select id="existing-connection">
<option value="">Enroll a new server connection</option>
      ${state.connections.map((c) => `<option value="${esc(c.id)}" ${e.connectionId === c.id ? "selected" : ""}>${esc(c.name)} · ${esc(c.credential)}</option>`).join("")}
    </select>
</label>
<p>Choose an existing connection for another nonoverlapping local copy. New enrollment fields below apply only to a new connection.</p>${field("url", "Server URL", e.server, "url")}${field("alias", "Connection name", e.name)}${field("device", "Device name", e.device)}${field("password", "Account password, if required (never retained)", "", "password")}`;
  if (e.step === 1)
    body = `<h2>${{ pending: "Waiting for approval", approved: "Device approved", denied: "Enrollment denied", expired: "Enrollment expired", error: "Connection interrupted" }[e.status]}</h2>
<p>Compare this verification code with the server operator.</p>
<div class="verification">${esc(e.code)}</div>
<p>Device: ${esc(e.device)} · Request: ${esc(e.id)}</p>
<p>Pending enrollment identity persists across restarts and temporary network failures.</p>${e.admin ? button("Open server administration", "admin") : "<p>No web administration is advertised. Ask the server operator to approve externally.</p>"}<div class="actions rule">${e.status === "pending" ? button("Check approval", "check-approval") : e.status === "error" ? button("Retry pending request", "check-approval") : ["denied", "expired"].includes(e.status) ? button("Request new enrollment", "new-enrollment") : ""}</div>`;
  if (e.step === 2)
    body = `<h2>Give this vault a local home</h2>
<label class="field">Vault<select id="vault">${["documents", "notes", "media"].map((v) => `<option ${v === e.vault ? "selected" : ""}>${v}</option>`).join("")}</select>
</label>${field("recovery", "Recovery key (never retained)", "", "password")}<p>A recovery key unlocks vault encryption; it is not your account password or a backup of your files. Keep your original safe: this app cannot retrieve it later.</p>${field("local-path", "Local folder", e.path)}${button("Choose folder…", "choose-folder")}<div class="quietbox">
<strong>This destination already contains files.</strong>
<p>Local and remote contents will be reconciled. Both conflicting versions are preserved. Preexisting files are not implicit remote deletions.</p>
</div>${check("consent", "I understand that this folder’s contents will be reconciled.", e.consent)}<p>Choose a nonoverlapping absolute path. Connecting never silently starts transfers.</p>`;
  if (e.step === 3) body = `<h2>How should nanosync run?</h2>${lifecycle()}`;
  if (e.step === 4)
    body = `<h2>Connected. Not syncing yet.</h2>
<p>${esc(e.name)} / ${esc(e.vault)}</p>
<p class="path">${esc(e.path)}</p>
<p>No transfers start until you explicitly choose <strong>Start syncing</strong>. Finish without syncing creates a durable paused binding.</p>`;
  return (
    head(
      "Connect folder",
      "A local copy, connected on purpose.",
      button("Cancel setup", "cancel-setup"),
    ) +
    `<div class="steps" aria-label="Setup progress">${["Server", "Verify device", "Vault & folder", "Background", "Start"].map((s, i) => `<span ${e.step === i ? 'aria-current="step" class="active"' : ""}>${i + 1}. ${s}</span>`).join("")}</div>
<div class="wizard">${body}<p id="form-error" role="alert" class="error">
</p>
<div class="bottom">${e.step > 0 ? button("Back", "back") : "<span></span>"}<div class="actions">${e.step === 4 ? button("Finish without syncing", "finish") + button("Start syncing", "start-sync", "primary") : button(e.step === 0 ? "Request enrollment" : e.step === 2 ? "Connect folder" : "Continue", "next", "primary")}</div>
</div>
</div>`
  );
}
function ignoresView() {
  return (
    head(
      "Ignore rules",
      `${esc(folder().name)} · this local binding only`,
      button("Back to folder", "folders"),
    ) +
    `<div class="textcol">
<label for="rules">.nanosyncignore rules</label>
<textarea id="rules" spellcheck="false">${esc(folder().rules)}</textarea>
<p>Uses the shared engine’s existing syntax. Unsupported negation (!), backslashes and character classes are rejected. Ignore rules cannot unignore protected metadata. Rules apply only to this copy, not other devices. Saving never deletes local or remote data. Existing tracked files are not silently deleted. Newly unignored files may reconcile with remote contents and create preserved conflicts.</p>
<p id="validation" role="status">
</p>
<div class="actions">${button("Validate rules", "validate")}${button("Save rules", "save-ignores", "primary")}</div>
</div>`
  );
}
function render() {
  const focused = document.activeElement as HTMLElement | null;
  const restoreControl = focused && content.contains(focused);
  document.documentElement.dataset["theme"] =
    state.settings.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.settings.theme;
  document
    .querySelectorAll<HTMLElement>("[data-nav]")
    .forEach((el) =>
      el.setAttribute(
        "aria-current",
        el.dataset["nav"] === view ? "page" : "false",
      ),
    );
  if (state.quit || state.hidden)
    content.innerHTML =
      head(
        state.quit ? "Desktop stopped" : "Window hidden",
        "Independently CLI-owned syncing continues; shared pauses remain in effect.",
        button("Reopen nanosync", "reopen"),
      );
  else
    content.innerHTML = (
      {
        folders: foldersView,
        conflicts: conflictsView,
        connections: connectionsView,
        settings: settingsView,
        connect: wizardView,
        ignores: ignoresView,
      }[view] || foldersView
    )();
  save();
  if (restoreControl && !dialog.open) {
    const replacement = [
      ...content.querySelectorAll<HTMLElement>(
        "button, input, select, textarea",
      ),
    ].find((el) =>
      focused.id
        ? el.id === focused.id
        : ["act", "folder", "tab"].some(
            (key) =>
              focused.dataset[key] && el.dataset[key] === focused.dataset[key],
          ),
    );
    (replacement || content).focus();
  }
  // A removed modal trigger cannot receive the browser's native focus restoration.
  if (
    !dialog.open &&
    (document.activeElement === document.body ||
      document.activeElement === dialog)
  ) {
    content.focus();
  }
}
function admin() {
  modal(
    "External server administration",
    `<p>The server operator handles device approval in server administration.</p>${button("Close", "modal-close")}`,
  );
}
function connectionDetails() {
  const c = state.connections.find((c) => c.id === connectionId)!;
  modal(
    `${esc(c.name)} connection`,
    `<p>${esc(c.url)}</p>
<p>Credential mode: ${esc(c.credential)}</p>${c.admin ? button("Open server administration", "admin") : "<p>No web administration offered; contact the operator externally.</p>"}<div class="actions">${c.credential !== "os" ? button(c.credential === "locked" ? "Unlock credentials" : "Review credential migration", "credential") : ""}${button("Remove connection", "remove-connection")}${button("Close", "modal-close")}</div>`,
  );
}
function credentialDecision() {
  const c = state.connections.find((c) => c.id === connectionId)!;
  close();
  if (c.credential === "locked")
    modal(
      "Unlock the OS credential store",
      `<p>Unlock the OS credential store to continue. No plaintext fallback.</p>
<div class="actions">${button("Cancel", "modal-close")}${button("Unlock", "confirm-unlock")}</div>`,
    );
  else
    modal(
      "Protected-file credential decision",
      `<p>Headless CLI explicitly uses protected-file credentials. Nothing has been changed. Keeping this mode leaves desktop access blocked and CLI usable.</p>
<p>Migrating to the OS store can prevent headless operation without an unlocked user session. Active CLI owners must release ownership first. No duplicate secrets or plaintext fallback.</p>${check("migration-consent", "I explicitly choose migration and understand the headless CLI impact.", false)}<div class="actions">${button("Keep protected-file mode", "modal-close")}${button("Migrate to OS credential store", "migrate")}</div>`,
    );
}
function disconnectDialog(connection: boolean) {
  const affected = connection
    ? state.folders.filter((f) => f.server === connectionId)
    : [folder()];
  modal(
    connection
      ? "Remove this connection?"
      : `Disconnect ${esc(folder().name)}?`,
    `<p>Local files and remote data are preserved. No device is revoked remotely.</p>
<p>Affected bindings: ${affected.map((f) => esc(f.name)).join(", ") || "none"}. Pending work: ${affected.reduce((n, f) => n + f.pending, 0)} items.</p>
<p>Active independently CLI-owned bindings cannot be bypassed; release ownership in the CLI first. Desktop-owned work stops at a safe boundary.</p>${check("abandon", "I explicitly accept abandoning pending synchronization state for affected bindings.", false)}<div class="actions">${button("Keep connected", "modal-close")}${button(connection ? "Confirm removal" : "Confirm disconnect", connection ? "confirm-remove" : "confirm-disconnect")}</div>`,
  );
}
function finish(start: boolean) {
  const e = enrollment();
  if (e.connectionId) {
    const connection = state.connections.find((c) => c.id === e.connectionId);
    if (!connection || connection.credential !== "os") {
      error(
        "The selected connection is unavailable or locked. Return to Connections before finishing.",
      );
      return;
    }
  }
  if (e.status !== "approved" || !e.consent) {
    error("Approval and reconciliation consent are required before finishing.");
    return;
  }
  if (state.folders.some((f) => overlaps(f.path, e.path))) {
    error("This path overlaps an existing binding.");
    return;
  }
  const id = `connection-${crypto.randomUUID()}`;
  if (!e.connectionId)
    state.connections.push({
      id,
      name: e.name,
      url: e.server,
      credential: "os",
      admin: e.admin,
    });
  state.folders.push({
    id,
    name: `${e.vault} · new copy`,
    server: e.connectionId || id,
    vault: e.vault,
    path: e.path,
    owner: "Desktop",
    status: "Syncing",
    paused: !start,
    last: "Never",
    pending: 1,
    rules: "",
  });
  state.enrollment = null;
  selected = id;
  go("folders");
  notify(
    start
      ? "Syncing started."
      : "Connected paused. No transfers started.",
  );
}
function next() {
  const e = enrollment();
  if (e.step === 0) {
    const existing = state.connections.find(
      (c) => c.id === value("existing-connection"),
    );
    if (existing) {
      if (existing.credential !== "os") {
        error(
          "Unlock or review protected-file migration in Connections before opening this state. No plaintext fallback.",
        );
        return;
      }
      e.connectionId = existing.id;
      e.server = existing.url;
      e.name = existing.name;
      e.admin = existing.admin;
      e.status = "approved";
      e.step = 2;
      (document.getElementById("password") as HTMLInputElement).value = "";
      render();
      content.focus();
      return;
    }
    try {
      const url = new URL(value("url"));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
    } catch {
      error("Enter an HTTP(S) server URL without credentials.");
      return;
    }
    if (!value("alias").trim() || !value("device").trim()) {
      error("Enter a connection and device name.");
      return;
    }
    const server = value("url").trim();
    const device = value("device").trim();
    if (server !== e.server || device !== e.device || e.connectionId) {
      e.id = `request-${crypto.randomUUID()}`;
      e.code = crypto.randomUUID().slice(0, 8).toUpperCase();
      e.status = "pending";
      e.consent = false;
    }
    delete e.connectionId;
    e.server = server;
    e.name = value("alias").trim();
    e.device = device;
    (document.getElementById("password") as HTMLInputElement).value = "";
  }
  if (e.step === 1 && e.status !== "approved") {
    error("Approval is required before choosing a vault.");
    return;
  }
  if (e.step === 2) {
    let path: string;
    try {
      path = normalizePath(value("local-path").trim());
    } catch (err) {
      error((err as Error).message);
      return;
    }
    if (state.folders.some((f) => overlaps(path, normalizePath(f.path)))) {
      error(
        "This path overlaps an existing binding. Choose a separate folder.",
      );
      return;
    }
    if (!value("recovery").trim()) {
      error("Enter a recovery key. It is never retained.");
      return;
    }
    if (!checked("consent")) {
      error("Acknowledge reconciliation of this nonempty folder.");
      return;
    }
    e.path = path;
    e.vault = value("vault");
    e.consent = true;
    (document.getElementById("recovery") as HTMLInputElement).value = "";
  }
  e.step++;
  render();
  content.focus();
}
function actions(action: string) {
  if (["folders", "conflicts", "connections", "settings"].includes(action)) {
    go(action);
    return;
  }
  if (action.startsWith("connection:")) {
    connectionId = action.slice(11);
    connectionDetails();
    return;
  }
  if (action.startsWith("resolve:")) {
    resolving = action.slice(8);
    modal(
      "Acknowledge manual resolution?",
      `<p>Review both versions in your own editor first. Acknowledgment clears the conflict record; neither version is discarded.</p>${check("resolved", "I reviewed both preserved versions and manually resolved the content.", false)}<div class="actions">${button("Cancel", "modal-close")}${button("Acknowledge resolution", "confirm-resolve")}</div>`,
    );
    return;
  }
  switch (action) {
    case "connect":
      if (!state.enrollment)
        state.enrollment = {
          id: `request-${crypto.randomUUID()}`,
          code: crypto.randomUUID().slice(0, 8).toUpperCase(),
          server: "https://sync.home.example",
          name: "home",
          device: "workstation",
          status: "pending",
          outcome: "approved",
          admin: true,
          step: 0,
          vault: "documents",
          path: "/home/alex/Sync/documents",
          consent: false,
        };
      go("connect");
      break;
    case "resume-enrollment":
      go("connect");
      break;
    case "cancel-setup":
      state.enrollment = null;
      go("folders");
      break;
    case "next":
      next();
      break;
    case "back":
      enrollment().step--;
      render();
      break;
    case "check-approval":
      enrollment().status = enrollment().outcome;
      render();
      break;
    case "new-enrollment":
      enrollment().id = `request-${crypto.randomUUID()}`;
      enrollment().code = crypto.randomUUID().slice(0, 8).toUpperCase();
      enrollment().status = "pending";
      render();
      break;
    case "admin":
      close();
      admin();
      break;
    case "choose-folder":
      notify(
        "Enter the folder path in the Local folder field.",
      );
      break;
    case "finish":
      finish(false);
      break;
    case "start-sync":
      finish(true);
      break;
    case "global":
      state.globalPaused = !state.globalPaused;
      render();
      break;
    case "pause":
      folder().paused = !folder().paused;
      render();
      notify(
        "Durable shared folder pause updated. Current filesystem work reaches a safe stopping point.",
      );
      break;
    case "open":

      break;
    case "sync":
      notify(
        `Sync requested through the ${folder().owner} owner.`,
      );
      break;
    case "retry":
      notify(
        "Folder or server still unavailable. State preserved.",
      );
      break;
    case "unlock":
      connectionId = folder().server;
      credentialDecision();
      break;
    case "credential":
      if (!dialog.open) connectionId = folder().server;
      credentialDecision();
      break;
    case "confirm-unlock":
      state.connections.find((c) => c.id === connectionId)!.credential = "os";
      close();
      render();
      notify("Credential store unlocked.");
      break;
    case "migrate":
      if (!checked("migration-consent")) {
        error("Explicit migration consent required.");
        return;
      }
      if (
        state.folders.some(
          (f) => f.server === connectionId && f.owner === "CLI",
        )
      ) {
        error(
          "CLI owner must release its binding before migration. Nothing changed.",
        );
        return;
      }
      state.connections.find((c) => c.id === connectionId)!.credential = "os";
      close();
      render();
      notify("Credential migration preference saved.");
      break;
    case "disconnect":
      disconnectDialog(false);
      break;
    case "remove-connection":
      close();
      disconnectDialog(true);
      break;
    case "confirm-remove":
    case "confirm-disconnect": {
      if (!checked("abandon")) {
        error(
          "Explicit acknowledgment of pending synchronization state is required.",
        );
        return;
      }
      const affected =
        action === "confirm-remove"
          ? state.folders.filter((f) => f.server === connectionId)
          : [folder()];
      if (affected.some((f) => f.owner === "CLI")) {
        error(
          "Blocked by active CLI owner. Release ownership through the CLI first; no locks bypassed.",
        );
        return;
      }
      state.folders = state.folders.filter((f) => !affected.includes(f));
      state.conflicts = state.conflicts.filter(
        (c) => !affected.some((f) => f.id === c.folder),
      );
      if (action === "confirm-remove") {
        state.connections = state.connections.filter(
          (c) => c.id !== connectionId,
        );
        if (state.enrollment?.connectionId === connectionId) {
          state.enrollment = null;
          if (view === "connect") view = "connections";
        }
      }
      selected = state.folders[0]?.id || "";
      close();
      render();
      notify("Disconnected. All local files and remote data preserved.");
      break;
    }
    case "confirm-resolve": {
      if (!checked("resolved")) {
        error("Confirm manual review and resolution first.");
        return;
      }
      const c = state.conflicts.find((c) => c.id === resolving)!;
      state.conflicts = state.conflicts.filter((c) => c.id !== resolving);
      if (!state.conflicts.some((x) => x.folder === c.folder)) {
        const f = state.folders.find((f) => f.id === c.folder);
        if (f) {
          f.status = "Up to date";
          f.pending = 0;
        }
      }
      close();
      render();
      notify(
        "Manual resolution acknowledged. Both file versions preserved; no files modified.",
      );
      break;
    }
    case "ignores":
      validated = null;
      go("ignores");
      break;
    case "validate":
      try {
        new IgnoreMatcher(value("rules"));
        validated = value("rules");
        document.getElementById("validation")!.textContent =
          "Validation passed. Ready to save.";
      } catch (err) {
        validated = null;
        document.getElementById("validation")!.textContent = (
          err as Error
        ).message;
      }
      break;
    case "save-ignores":
      if (validated !== value("rules")) {
        document.getElementById("validation")!.textContent =
          "Validate the current rules before saving.";
        return;
      }
      folder().rules = validated;
      go("folders");
      notify(
        "Ignore rules saved for this binding. No files deleted.",
      );
      break;
    case "diagnostics":
      modal(
        "Review diagnostics",
        `<pre class="export">${esc(JSON.stringify(report(), null, 2))}</pre>
<p>No paths, filenames, contents, secrets or enrollment identity. Nothing uploaded.</p>
<div class="actions">${button("Cancel", "modal-close")}${button("Export diagnostics", "export")}</div>`,
      );
      break;
    case "export": {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report(), null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "nanosync-diagnostics.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      close();
      notify("Diagnostics exported. Nothing uploaded.");
      break;
    }
    case "quit":
    case "close-window":
      modal(
        action === "quit" ? "Quit nanosync?" : "Close window?",
        `<p>${action === "close-window" && state.settings.background ? "Closing hides the window and keeps desktop-owned sync running. Reopen from the launcher." : "Desktop-owned syncing stops safely. Independently CLI-owned syncing continues. Shared pauses are preserved."}</p>
<div class="actions">${button("Cancel", "modal-close")}${button(action === "quit" ? "Quit desktop" : "Close window", action === "quit" ? "confirm-quit" : "confirm-close")}</div>`,
      );
      break;
    case "confirm-quit":
      state.quit = true;
      close();
      render();
      break;
    case "confirm-close":
      state.hidden = state.settings.background;
      state.quit = !state.settings.background;
      close();
      render();
      break;
    case "reopen":
      state.quit = false;
      state.hidden = false;
      render();
      break;
    case "modal-close":
      close();
      break;
  }
  save();
}
function report() {
  return {
    source: "nanosync",
    platform: "Linux",
    folderCount: state.folders.length,
    statuses: state.folders.map((f) => ({
      status: folderStatus(state, f),
      owner: f.owner,
      pending: f.pending,
    })),
    privacy: "paths, filenames, contents, credentials and keys excluded",
  };
}
document.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("button, [data-folder]");
  if (!el) return;
  if (el.dataset["nav"]) go(el.dataset["nav"]!);
  else if (el.dataset["folder"]) {
    selected = el.dataset["folder"]!;
    render();
  } else if (el.dataset["tab"]) {
    tab = el.dataset["tab"]!;
    render();
  } else if (el.dataset["act"]) actions(el.dataset["act"]!);
});
document.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id in state.settings && el.id !== "theme") {
    const key = el.id as keyof Omit<typeof state.settings, "theme">;
    state.settings[key] = el.checked;
    render();
    document.getElementById(el.id)?.focus();
  } else if (el.id === "theme") {
    state.settings.theme = el.value as typeof state.settings.theme;
    render();
    document.getElementById(el.id)?.focus();
  }
});
document.addEventListener("input", (event) => {
  if ((event.target as HTMLElement).id === "rules") {
    validated = null;
    document.getElementById("validation")!.textContent =
      "Rules changed. Validate before saving.";
  }
});
render();

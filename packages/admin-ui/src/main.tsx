import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./paper/Button";
import { TextField } from "./paper/TextField";
import { Dialog } from "./paper/Dialog";
import { parseEncryptedVaultCreateRequest } from "@nanosync/protocol";
import { prepare, verify, type Creation } from "./creation";
import "./paper/styles.css";
import "./styles.css";
type Device = {
  deviceId: string;
  displayName: string;
  platform: string;
  clientVersion: string;
  state: string;
  verificationCode?: string;
  requestedAtMs: number;
};
type Vault = { vaultId: string; name: string };
type Activity = {
  sequence: number;
  action: string;
  origin: string;
  targetId: string;
  occurredAtMs: number;
};
const receiptKey = "nanosync-encrypted-creation-v1";
function App() {
  const [csrf, setCsrf] = useState(""),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]),
    [pending, setPending] = useState<Device[]>([]),
    [vaults, setVaults] = useState<Vault[]>([]),
    [activity, setActivity] = useState<Activity[]>([]);
  const [creation, setCreation] = useState<Creation | null>(null),
    [secret, setSecret] = useState(""),
    [saved, setSaved] = useState(false),
    [ack, setAck] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: "delete" | "rename" | "revoke";
    id: string;
    name: string;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    token = csrf,
  ): Promise<any> {
    const response = await fetch("/admin/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Nanosync-CSRF": token || "login",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) setCsrf("");
      throw Object.assign(new Error(result.message ?? `Request failed (${response.status})`), {status:response.status});
    }
    return result;
  }
  async function refresh(token = csrf) {
    const [d, v, a] = await Promise.all([
      api("devices", "GET", undefined, token),
      api("vaults", "GET", undefined, token),
      api("activity", "GET", undefined, token),
    ]);
    setDevices(d.devices);
    setPending(d.enrollments);
    setVaults(v.vaults);
    setActivity(a.activity);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      try {
        const stored = localStorage.getItem(receiptKey);
        if (stored) {
          setCreation(parseEncryptedVaultCreateRequest(JSON.parse(stored)));
          setSaved(true);
        }
        try {
          const s = await api("session");
          setCsrf(s.csrfToken);
          await refresh(s.csrfToken);
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 401)) throw error;
        }
      } finally {
        setReady(true);
      }
    });
  }, []);
  const form = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return new FormData(event.currentTarget);
  };
  const open = (
    event: React.MouseEvent<HTMLButtonElement>,
    kind: "delete" | "rename" | "revoke",
    id: string,
    name: string,
  ) => {
    trigger.current = event.currentTarget;
    setDialog({ kind, id, name });
  };
  return (
    <main className="nv-root" data-nv-theme="light">
      <div className="admin nv-stack">
        <h1>Nanosync administration</h1>
        {error && !dialog && <p role="alert">{error}</p>}
        {!ready ? (
          <p>Loading…</p>
        ) : !csrf ? (
          <form
            className="nv-panel nv-stack"
            onSubmit={(e) => {
              const f = form(e);
              e.currentTarget.reset();
              void run(async () => {
                const s = await api("session", "POST", {
                  password: f.get("password"),
                });
                setCsrf(s.csrfToken);
                await refresh(s.csrfToken);
              });
            }}
          >
            <TextField
              label="Owner password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Button type="submit" disabled={busy}>
              Log in
            </Button>
          </form>
        ) : (
          <>
            <div className="nv-actions">
              <Button disabled={busy} onClick={() => void run(() => refresh())}>
                Refresh
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("session", "DELETE");
                    setCsrf("");
                    setSecret("");
                    setAck(false);
                  })
                }
              >
                Log out
              </Button>
            </div>
            <section className="nv-panel nv-stack">
              <h2>Pending requests</h2>
              <p>
                Compare the complete verification code with the enrolling device
                before approval. The code is not authentication material.
              </p>
              {pending.length === 0 && <p>No pending requests.</p>}
              {pending.map((d) => (
                <article key={d.deviceId}>
                  <h3>{d.displayName}</h3>
                  <p>
                    {d.platform} · {d.clientVersion}
                  </p>
                  <p>
                    Requested{" "}
                    <time>{new Date(d.requestedAtMs).toLocaleString()}</time>
                  </p>
                  <p>{d.deviceId}</p>
                  <code>{d.verificationCode}</code>
                  <div className="nv-actions">
                    {(["approve", "deny"] as const).map((action) => (
                      <Button
                        key={action}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `devices/${d.deviceId}/${action}`,
                              "POST",
                              {},
                            );
                            await refresh();
                          })
                        }
                      >
                        {action === "approve" ? "Approve" : "Deny"}{" "}
                        {d.displayName}
                      </Button>
                    ))}
                  </div>
                </article>
              ))}
            </section>
            <section className="nv-panel nv-stack">
              <h2>Clients</h2>
              {["active", "revoked"].map((state) => (
                <div key={state}>
                  <h3>
                    {state === "active" ? "Active clients" : "Revoked clients"}
                  </h3>
                  {devices
                    .filter((d) => d.state === state)
                    .map((d) => (
                      <article key={d.deviceId}>
                        <p>
                          {d.displayName} · {d.platform} · {d.clientVersion} ·{" "}
                          {d.deviceId}
                        </p>
                        {state === "active" && (
                          <Button
                            onClick={(e) =>
                              open(e, "revoke", d.deviceId, d.displayName)
                            }
                          >
                            Revoke {d.displayName}
                          </Button>
                        )}
                      </article>
                    ))}
                </div>
              ))}
            </section>
            <section className="nv-panel nv-stack">
              <h2>Vaults</h2>
              {vaults.map((v) => (
                <article key={v.vaultId}>
                  <h3>{v.name}</h3>
                  <p>{v.vaultId}</p>
                  <div className="nv-actions">
                    <Button
                      onClick={(e) => open(e, "rename", v.vaultId, v.name)}
                    >
                      Rename {v.name}
                    </Button>
                    <Button
                      onClick={(e) => open(e, "delete", v.vaultId, v.name)}
                    >
                      Delete {v.name}
                    </Button>
                  </div>
                </article>
              ))}
              {!creation ? (
                <form
                  className="nv-stack"
                  onSubmit={(e) => {
                    const f = form(e);
                    void run(async () => {
                      const c = await prepare(String(f.get("name")));
                      setCreation(c.request);
                      setSecret(c.secret);
                      setAck(false);
                      setSaved(false);
                    });
                  }}
                >
                  <TextField
                    label="New vault name"
                    name="name"
                    required
                    maxLength={128}
                  />
                  <Button type="submit" disabled={busy}>
                    Prepare recovery
                  </Button>
                </form>
              ) : (
                <div className="nv-stack">
                  <h3>Create {creation.name}</h3>
                  {!saved ? (
                    <>
                      <p>
                        Save this recovery secret securely. It cannot be
                        retrieved later. No vault has been published.
                      </p>
                      <code data-testid="recovery-secret">{secret}</code>
                      <label>
                        <input
                          type="checkbox"
                          checked={ack}
                          onChange={(e) => setAck(e.target.checked)}
                        />{" "}
                        I saved the recovery secret
                      </label>
                      <Button
                        disabled={!ack || busy}
                        onClick={() =>
                          void run(async () => {
                            await navigator.locks.request(receiptKey, () => {
                              const existing = localStorage.getItem(receiptKey);
                              if (existing && existing !== JSON.stringify(creation))
                                throw new Error("Another tab saved a creation receipt. Reload to resume it; this preparation remains unpublished.");
                              localStorage.setItem(receiptKey, JSON.stringify(creation));
                            });
                            setSaved(true);
                            setSecret("");
                          })
                        }
                      >
                        Save encrypted receipt
                      </Button>
                    </>
                  ) : (
                    <form
                      className="nv-stack"
                      onSubmit={(e) => {
                        const f = form(e);
                        e.currentTarget.reset();
                        void run(async () => {
                          await verify(creation, String(f.get("secret")));
                          await api("vaults", "POST", creation);
                          await navigator.locks.request(receiptKey, () => {
                            if (localStorage.getItem(receiptKey) === JSON.stringify(creation))
                              localStorage.removeItem(receiptKey);
                          });
                          setCreation(null);
                          setSecret("");
                          setAck(false);
                          await refresh();
                        });
                      }}
                    >
                      <p>
                        Reenter your saved secret to verify the encrypted
                        receipt before publishing or retrying. Lost responses
                        replay the same vault, never a duplicate.
                      </p>
                      <TextField
                        label="Saved recovery secret"
                        name="secret"
                        type="password"
                        autoComplete="off"
                        required
                      />
                      <Button type="submit" disabled={busy}>
                        Verify and publish
                      </Button>
                    </form>
                  )}
                  {!saved && (
                    <Button
                      onClick={() => {
                        setCreation(null);
                        setSecret("");
                        setAck(false);
                      }}
                    >
                      Discard unpublished preparation
                    </Button>
                  )}
                </div>
              )}
            </section>
            <section className="nv-panel nv-stack">
              <h2>Recent activity</h2>
              {activity.map((a) => (
                <article key={a.sequence}>
                  <strong>{a.action}</strong>
                  <p>
                    {a.origin} ·{" "}
                    <time dateTime={new Date(a.occurredAtMs).toISOString()}>
                      {new Date(a.occurredAtMs).toLocaleString()}
                    </time>
                  </p>
                  <p>{a.targetId}</p>
                </article>
              ))}
            </section>
          </>
        )}
        <Dialog
          open={!!dialog}
          onOpenChange={(value) => {
            if (!value && !busy) setDialog(null);
          }}
          title={
            dialog
              ? `${dialog.kind === "delete" ? "Delete" : dialog.kind === "revoke" ? "Revoke" : "Rename"} ${dialog.name}`
              : ""
          }
          description={
            dialog?.kind === "delete"
              ? "Permanent deletion destroys metadata, history, encrypted objects and recovery wraps. Recovery secrets cannot restore deleted data without a server backup. Offline and connected clients may have unsynced work. Client files are not erased."
              : dialog?.kind === "revoke"
                ? "Revocation prevents future server access. It does not erase downloaded ciphertext, plaintext or keys."
                : "Change the vault display name."
          }
          theme="light"
          triggerRef={trigger}
        >
          <form
            className="nv-stack"
            onSubmit={(e) => {
              const f = form(e);
              e.currentTarget.reset();
              void run(async () => {
                if (!dialog) return;
                const d = dialog;
                if (d.kind === "revoke")
                  await api(`devices/${d.id}/revoke`, "POST", {});
                else
                  await api(
                    `vaults/${d.id}/${d.kind}`,
                    "POST",
                    d.kind === "rename"
                      ? { name: f.get("name") }
                      : {
                          confirmName: f.get("confirmName"),
                          password: f.get("password"),
                        },
                  );
                setDialog(null);
                await refresh();
              });
            }}
          >
            {error && <p role="alert">{error}</p>}
            <Button autoFocus disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            {dialog?.kind === "rename" && (
              <TextField
                label="Vault name"
                name="name"
                defaultValue={dialog.name}
                required
              />
            )}
            {dialog?.kind === "delete" && (
              <>
                <TextField
                  label="Exact vault name"
                  name="confirmName"
                  required
                  pattern={undefined}
                />
                <TextField
                  label="Owner password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </>
            )}
            <Button type="submit" disabled={busy}>
              {dialog?.kind === "delete"
                ? "Permanently delete"
                : dialog?.kind === "revoke"
                  ? "Confirm revocation"
                  : "Save name"}
            </Button>
          </form>
        </Dialog>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

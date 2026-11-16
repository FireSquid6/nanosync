import { Button } from "../paper/Button";
import { useActionDialog } from "../components/ActionDialog";
import { useAdmin } from "../state/AdminContext";

export function ClientsPage() {
  const { pending, devices, api, refresh, run, busy } = useAdmin();
  const { open, dialog } = useActionDialog();
  return <>
    <section className="nv-panel nv-stack">
      <h2>Pending requests</h2>
      <p>Compare the complete verification code with the enrolling device before approval. The code is not authentication material.</p>
      {pending.length === 0 && <p>No pending requests.</p>}
      {pending.map((device) => <article key={device.deviceId}>
        <h3>{device.displayName}</h3>
        <p>{device.platform} · {device.clientVersion}</p>
        <p>Requested <time>{new Date(device.requestedAtMs).toLocaleString()}</time></p>
        <p>{device.deviceId}</p>
        <code>{device.verificationCode}</code>
        <div className="nv-actions">
          {(["approve", "deny"] as const).map((action) => (
            <Button key={action} disabled={busy} onClick={() => void run(async () => {
              await api(`devices/${device.deviceId}/${action}`, "POST", {});
              await refresh();
            })}>
              {action === "approve" ? "Approve" : "Deny"} {device.displayName}
            </Button>
          ))}
        </div>
      </article>)}
    </section>
    <section className="nv-panel nv-stack">
      <h2>Clients</h2>
      {["active", "revoked"].map((state) => <div key={state}>
        <h3>{state === "active" ? "Active clients" : "Revoked clients"}</h3>
        {devices.filter((device) => device.state === state).map((device) => <article key={device.deviceId}>
          <p>{device.displayName} · {device.platform} · {device.clientVersion} · {device.deviceId}</p>
          {state === "active" && <Button disabled={busy} onClick={(event) => open(event, "revoke", device.deviceId, device.displayName)}>
            Revoke {device.displayName}
          </Button>}
        </article>)}
      </div>)}
    </section>
    {dialog}
  </>;
}

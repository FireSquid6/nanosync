import { Button } from "../paper/Button";
import { TextField } from "../paper/TextField";
import { formData } from "../forms";
import { useAdmin } from "../state/AdminContext";
import { useCreation } from "../state/CreationContext";

export function VaultCreation() {
  const { busy, run } = useAdmin();
  const { creation, secret, saved, acknowledged, acknowledge, prepareRecovery, saveReceipt, publish, discard } = useCreation();
  if (!creation) return (
    <form className="nv-stack" onSubmit={(event) => {
      const fields = formData(event);
      void run(() => prepareRecovery(String(fields.get("name"))));
    }}>
      <TextField label="New vault name" name="name" required maxLength={128} />
      <Button type="submit" disabled={busy}>Prepare recovery</Button>
    </form>
  );
  return (
    <div className="nv-stack">
      <h3>Create {creation.name}</h3>
      {!saved ? <>
        <p>Save this recovery secret securely. It cannot be retrieved later. No vault has been published.</p>
        <code data-testid="recovery-secret">{secret}</code>
        <label>
          <input type="checkbox" checked={acknowledged} onChange={(event) => acknowledge(event.target.checked)} />{" "}
          I saved the recovery secret
        </label>
        <Button disabled={!acknowledged || busy} onClick={() => void run(saveReceipt)}>Save encrypted receipt</Button>
      </> : (
        <form className="nv-stack" onSubmit={(event) => {
          const fields = formData(event);
          event.currentTarget.reset();
          void run(() => publish(String(fields.get("secret"))));
        }}>
          <p>Reenter your saved secret to verify the encrypted receipt before publishing or retrying. Lost responses replay the same vault, never a duplicate.</p>
          <TextField label="Saved recovery secret" name="secret" type="password" autoComplete="off" required />
          <Button type="submit" disabled={busy}>Verify and publish</Button>
        </form>
      )}
      {!saved && <Button disabled={busy} onClick={discard}>Discard unpublished preparation</Button>}
    </div>
  );
}

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
      <Button type="submit" disabled={busy}>Prepare recovery key</Button>
    </form>
  );
  return (
    <div className="nv-stack">
      <h3>Create {creation.name}</h3>
      {!saved ? <>
        <p>Your vault recovery key unlocks this vault’s encryption key on new devices. It is not your owner password or a backup of your files.</p>
        <p>Save it in a password manager or offline. Anyone with this key and the encrypted vault data can decrypt your files. It cannot be retrieved later. No vault has been published.</p>
        <code data-testid="recovery-secret">{secret}</code>
        <label>
          <input type="checkbox" checked={acknowledged} onChange={(event) => acknowledge(event.target.checked)} />{" "}
          I saved the vault recovery key
        </label>
        <Button disabled={!acknowledged || busy} onClick={() => void run(saveReceipt)}>Save encrypted receipt</Button>
      </> : (
        <form className="nv-stack" onSubmit={(event) => {
          const fields = formData(event);
          event.currentTarget.reset();
          void run(() => publish(String(fields.get("secret"))));
        }}>
          <p>Reenter your saved vault recovery key to verify the encrypted receipt before publishing or retrying. Lost responses replay the same vault, never a duplicate.</p>
          <TextField label="Vault recovery key" name="secret" type="password" autoComplete="off" required />
          <Button type="submit" disabled={busy}>Verify and publish</Button>
        </form>
      )}
      {!saved && <Button disabled={busy} onClick={discard}>Discard unpublished preparation</Button>}
    </div>
  );
}

import { useRef, useState, type MouseEvent, type RefObject } from "react";
import { Button } from "../paper/Button";
import { Dialog } from "../paper/Dialog";
import { TextField } from "../paper/TextField";
import { formData } from "../forms";
import { useAdmin } from "../state/AdminContext";

type Action = { kind: "delete" | "rename" | "revoke"; id: string; name: string };

export function useActionDialog() {
  const [action, setAction] = useState<Action | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const { clearError } = useAdmin();
  function open(event: MouseEvent<HTMLButtonElement>, kind: Action["kind"], id: string, name: string) {
    trigger.current = event.currentTarget;
    clearError();
    setAction({ kind, id, name });
  }
  return { open, dialog: <ActionDialog action={action} close={() => setAction(null)} trigger={trigger} /> };
}

function ActionDialog({ action, close, trigger }: {
  action: Action | null;
  close: () => void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const { api, refresh, run, busy, error } = useAdmin();
  return (
    <Dialog
      open={!!action}
      onOpenChange={(open) => { if (!open && !busy) close(); }}
      title={action ? `${action.kind === "delete" ? "Delete" : action.kind === "revoke" ? "Revoke" : "Rename"} ${action.name}` : ""}
      description={action?.kind === "delete"
        ? "Permanent deletion destroys metadata, history, encrypted objects and recovery wraps. Recovery secrets cannot restore deleted data without a server backup. Offline and connected clients may have unsynced work. Client files are not erased."
        : action?.kind === "revoke"
          ? "Revocation prevents future server access. It does not erase downloaded ciphertext, plaintext or keys."
          : "Change the vault display name."}
      theme="light"
      triggerRef={trigger}
    >
      <form className="nv-stack" onSubmit={(event) => {
        const fields = formData(event);
        event.currentTarget.reset();
        void run(async () => {
          if (!action) return;
          if (action.kind === "revoke") await api(`devices/${action.id}/revoke`, "POST", {});
          else await api(`vaults/${action.id}/${action.kind}`, "POST", action.kind === "rename"
            ? { name: fields.get("name") }
            : { confirmName: fields.get("confirmName"), password: fields.get("password") });
          close();
          await refresh();
        });
      }}>
        {error && <p role="alert">{error}</p>}
        <Button autoFocus disabled={busy} onClick={close}>Cancel</Button>
        {action?.kind === "rename" && <TextField label="Vault name" name="name" defaultValue={action.name} required />}
        {action?.kind === "delete" && <>
          <TextField label="Exact vault name" name="confirmName" required />
          <TextField label="Owner password" name="password" type="password" autoComplete="current-password" required />
        </>}
        <Button type="submit" disabled={busy}>
          {action?.kind === "delete" ? "Permanently delete" : action?.kind === "revoke" ? "Confirm revocation" : "Save name"}
        </Button>
      </form>
    </Dialog>
  );
}

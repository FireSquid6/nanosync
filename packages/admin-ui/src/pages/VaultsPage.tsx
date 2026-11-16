import { Button } from "../paper/Button";
import { useActionDialog } from "../components/ActionDialog";
import { VaultCreation } from "../components/VaultCreation";
import { useAdmin } from "../state/AdminContext";

export function VaultsPage() {
  const { vaults, busy } = useAdmin();
  const { open, dialog } = useActionDialog();
  return <>
    <section className="nv-panel nv-stack">
      <h2>Vaults</h2>
      {vaults.map((vault) => <article key={vault.vaultId}>
        <h3>{vault.name}</h3>
        <p>{vault.vaultId}</p>
        <div className="nv-actions">
          <Button disabled={busy} onClick={(event) => open(event, "rename", vault.vaultId, vault.name)}>Rename {vault.name}</Button>
          <Button disabled={busy} onClick={(event) => open(event, "delete", vault.vaultId, vault.name)}>Delete {vault.name}</Button>
        </div>
      </article>)}
      <VaultCreation />
    </section>
    {dialog}
  </>;
}

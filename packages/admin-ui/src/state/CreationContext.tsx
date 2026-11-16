import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseEncryptedVaultCreateRequest } from "@nanosync/protocol";
import { prepare, verify, type Creation } from "../creation";
import { useAdmin } from "./AdminContext";

const receiptKey = "nanosync-encrypted-creation-v1";
type CreationState = {
  creation: Creation | null;
  secret: string;
  saved: boolean;
  acknowledged: boolean;
  acknowledge: (value: boolean) => void;
  prepareRecovery: (name: string) => Promise<void>;
  saveReceipt: () => Promise<void>;
  publish: (secret: string) => Promise<void>;
  discard: () => void;
};
const CreationContext = createContext<CreationState | null>(null);

/** Keep unpublished preparation across page changes, but not logout. Persist only ciphertext. */
export function CreationProvider({ children }: { children: ReactNode }) {
  const { api, refresh, run } = useAdmin();
  const [creation, setCreation] = useState<Creation | null>(null);
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [acknowledged, acknowledge] = useState(false);

  useEffect(() => {
    void run(async () => {
      const stored = localStorage.getItem(receiptKey);
      if (stored) {
        setCreation(parseEncryptedVaultCreateRequest(JSON.parse(stored)));
        setSaved(true);
      }
    });
  }, []);

  async function prepareRecovery(name: string) {
    const prepared = await prepare(name);
    setCreation(prepared.request);
    setSecret(prepared.secret);
    acknowledge(false);
    setSaved(false);
  }
  async function saveReceipt() {
    if (!creation || !acknowledged) return;
    await navigator.locks.request(receiptKey, () => {
      const existing = localStorage.getItem(receiptKey);
      if (existing && existing !== JSON.stringify(creation))
        throw new Error("Another tab saved a creation receipt. Reload to resume it; this preparation remains unpublished.");
      localStorage.setItem(receiptKey, JSON.stringify(creation));
    });
    setSaved(true);
    setSecret("");
  }
  async function publish(display: string) {
    if (!creation || !saved) return;
    await verify(creation, display);
    await api("vaults", "POST", creation);
    await navigator.locks.request(receiptKey, () => {
      if (localStorage.getItem(receiptKey) === JSON.stringify(creation))
        localStorage.removeItem(receiptKey);
    });
    setCreation(null);
    setSecret("");
    acknowledge(false);
    await refresh();
  }
  function discard() {
    if (saved) return;
    setCreation(null);
    setSecret("");
    acknowledge(false);
  }
  return (
    <CreationContext.Provider value={{ creation, secret, saved, acknowledged, acknowledge, prepareRecovery, saveReceipt, publish, discard }}>
      {children}
    </CreationContext.Provider>
  );
}

export function useCreation() {
  const value = useContext(CreationContext);
  if (!value) throw new Error("Vault creation state is unavailable");
  return value;
}

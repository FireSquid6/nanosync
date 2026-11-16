import {
  OWNER_GENESIS_AUTHOR_ID,
  parseEncryptedVaultCreateRequest,
  parsePersistedRevisionEnvelope,
} from "@nanosync/protocol";
import {
  encryptManifest,
  generateRecoverySecret,
  generateVaultMasterKey,
  displayRecoverySecret,
  wrapMasterKey,
  referenceSetMac,
  decodeRecoverySecret,
  unwrapMasterKey,
  decryptManifest,
} from "@nanosync/sync-core";
export type Creation = ReturnType<typeof parseEncryptedVaultCreateRequest>;
export async function prepare(name: string) {
  const vaultId = crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
    master = generateVaultMasterKey(),
    recovery = generateRecoverySecret();
  try {
    const encrypted = await encryptManifest(
      {
        version: 1,
        vaultId,
        revisionId,
        parents: [],
        creatingDeviceId: OWNER_GENESIS_AUTHOR_ID,
        entries: [
          {
            id: crypto.randomUUID(),
            parentId: null,
            name: "",
            kind: "directory",
          },
        ],
      },
      master,
    );
    const genesis = parsePersistedRevisionEnvelope({
      protocolVersion: 1,
      revisionFormatVersion: 1,
      vaultId,
      revisionId,
      parents: [],
      creatingDeviceId: OWNER_GENESIS_AUTHOR_ID,
      createdAt: new Date().toISOString(),
      encryptedManifestObjectId: encrypted.reference.objectId,
      references: [encrypted.reference],
      referenceSetMac: "0".repeat(64),
    });
    return {
      secret: await displayRecoverySecret(recovery),
      request: parseEncryptedVaultCreateRequest({
        vaultId,
        name,
        recoveryWrap: await wrapMasterKey(master, recovery, vaultId),
        genesisRevision: {
          ...genesis,
          referenceSetMac: await referenceSetMac(genesis, master),
        },
        frame: btoa(String.fromCharCode(...encrypted.frame))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      }),
    };
  } finally {
    master.fill(0);
    recovery.fill(0);
  }
}
export async function verify(request: Creation, display: string) {
  const secret = await decodeRecoverySecret(display);
  let master: Uint8Array | undefined;
  try {
    master = await unwrapMasterKey(
      request.recoveryWrap,
      secret,
      request.vaultId,
    );
    const frame = Uint8Array.from(
      atob(request.frame.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    await decryptManifest(frame, request.genesisRevision, master);
    if (
      (await referenceSetMac(request.genesisRevision, master)) !==
      request.genesisRevision.referenceSetMac
    )
      throw new Error("Invalid creation receipt");
  } finally {
    secret.fill(0);
    master?.fill(0);
  }
}

# Nanosync

Language for encrypted vault access and recovery.

## Language

**Vault recovery key**:
A per-vault secret that unlocks the vault master key on a new device. It is neither a server login credential nor a backup of vault contents.
_Avoid_: Backup password, recovery password, recovery secret (legacy name)

**Vault master key**:
The cryptographic root from which a vault’s encryption and authentication keys are derived.

**Owner password**:
The credential for server administration and initiating device enrollment. It does not unlock a vault’s encryption.

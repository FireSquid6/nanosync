import { randomBytes } from "node:crypto";
import { hashRaw, type Options as Argon2Options } from "@node-rs/argon2";
import type { PasswordVerifierRecord } from "@nanosync/server-metadata";

// @node-rs/argon2 declares these as ambient const enums, which cannot be imported
// under verbatimModuleSyntax. These locally named constants preserve its documented
// enum ABI: Algorithm.Argon2id = 2 and Version.V0x13 (Argon2 version 19) = 1.
const ARGON2ID_ALGORITHM: NonNullable<Argon2Options["algorithm"]> = 2;
const ARGON2_VERSION_19: NonNullable<Argon2Options["version"]> = 1;

export interface PasswordHasher { hash(passwordUtf8: Uint8Array): Promise<PasswordVerifierRecord>; }

export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(passwordUtf8: Uint8Array): Promise<PasswordVerifierRecord> {
    const salt = randomBytes(16);
    const hash = await hashRaw(passwordUtf8, { algorithm: ARGON2ID_ALGORITHM, version: ARGON2_VERSION_19, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32, salt });
    return { algorithm: "argon2id", version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 1, salt: Uint8Array.from(salt), hash: Uint8Array.from(hash) };
  }
}

export function passwordVerifierPhc(record: PasswordVerifierRecord): string {
  return `$argon2id$v=${record.version}$m=${record.memoryKiB},t=${record.iterations},p=${record.parallelism}$${Buffer.from(record.salt).toString("base64").replace(/=+$/, "")}$${Buffer.from(record.hash).toString("base64").replace(/=+$/, "")}`;
}

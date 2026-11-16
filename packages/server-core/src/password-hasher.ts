import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashRaw, type Options as Argon2Options } from "@node-rs/argon2";
import { ApiError } from "./http.ts";
import type { PasswordVerifierRecord } from "@nanosync/server-metadata";

// @node-rs/argon2 declares these as ambient const enums, which cannot be imported
// under verbatimModuleSyntax. These locally named constants preserve its documented
// enum ABI: Algorithm.Argon2id = 2 and Version.V0x13 (Argon2 version 19) = 1.
const ARGON2ID_ALGORITHM: NonNullable<Argon2Options["algorithm"]> = 2;
const ARGON2_VERSION_19: NonNullable<Argon2Options["version"]> = 1;

export interface PasswordHasher { hash(passwordUtf8: Uint8Array): Promise<PasswordVerifierRecord>; verify?(passwordUtf8: Uint8Array, record: PasswordVerifierRecord): Promise<boolean>; }

export class Argon2idPasswordHasher implements PasswordHasher {
  private readonly semaphore = new Semaphore(2);
  async hash(passwordUtf8: Uint8Array): Promise<PasswordVerifierRecord> {
    return this.semaphore.run(async () => {
      const salt = randomBytes(16);
      const hash = await hashRaw(passwordUtf8, { algorithm: ARGON2ID_ALGORITHM, version: ARGON2_VERSION_19, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32, salt });
      return { algorithm: "argon2id", version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 1, salt: Uint8Array.from(salt), hash: Uint8Array.from(hash) };
    });
  }
  async verify(passwordUtf8: Uint8Array, record: PasswordVerifierRecord): Promise<boolean> {
    validateRecord(record);
    return this.semaphore.run(async () => {
      const actual = await hashRaw(passwordUtf8, { algorithm: ARGON2ID_ALGORITHM, version: ARGON2_VERSION_19, memoryCost: record.memoryKiB, timeCost: record.iterations, parallelism: record.parallelism, outputLen: record.hash.length, salt: record.salt });
      return actual.length === record.hash.length && timingSafeEqual(actual, record.hash);
    });
  }
}

export function passwordVerifierPhc(record: PasswordVerifierRecord): string {
  return `$argon2id$v=${record.version}$m=${record.memoryKiB},t=${record.iterations},p=${record.parallelism}$${Buffer.from(record.salt).toString("base64").replace(/=+$/, "")}$${Buffer.from(record.hash).toString("base64").replace(/=+$/, "")}`;
}

function validateRecord(value: PasswordVerifierRecord): void {
  if (value.algorithm !== "argon2id" || value.version !== 19 || !Number.isSafeInteger(value.memoryKiB) || value.memoryKiB < 1 || value.memoryKiB > 1_048_576 || !Number.isSafeInteger(value.iterations) || value.iterations < 1 || value.iterations > 10 || !Number.isSafeInteger(value.parallelism) || value.parallelism < 1 || value.parallelism > 8 || !(value.salt instanceof Uint8Array) || value.salt.length < 16 || value.salt.length > 64 || !(value.hash instanceof Uint8Array) || value.hash.length < 32 || value.hash.length > 64) throw new TypeError("Password verifier is invalid");
}
class Semaphore {
  private active = 0;
  constructor(private readonly maximum: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new ApiError(429, "RATE_LIMITED", "Password hashing is temporarily unavailable", { "retry-after": "1" }, 1);
    this.active++;
    try { return await work(); } finally { this.active--; }
  }
}

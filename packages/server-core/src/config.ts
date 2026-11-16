import { isIP } from "node:net";
import { MAX_OBJECT_CIPHERTEXT_BYTES } from "@nanosync/protocol";

export interface ServerConfigInput {
  webUi?: boolean;
  externalOrigin?: string;
  trustedProxyAddresses?: string[];
  hostname?: string;
  port?: number;
  maximumObjectSize?: number;
  metadataDatabasePath?: string;
  objectStoragePath?: string;
  acknowledgeInsecureNonLoopback?: boolean;
}
export interface ServerConfig {
  webUi: boolean;
  externalOrigin?: string;
  trustedProxyAddresses: readonly string[];
  hostname: string;
  port: number;
  maximumObjectSize: number;
  metadataDatabasePath: string;
  objectStoragePath: string;
}

export function createServerConfig(input: ServerConfigInput = {}, warn: (message: string) => void = console.warn): ServerConfig {
  const hostname = input.hostname ?? "127.0.0.1";
  const port = input.port ?? 7337;
  const maximumObjectSize = input.maximumObjectSize ?? MAX_OBJECT_CIPHERTEXT_BYTES;
  const metadataDatabasePath = validPath(input.metadataDatabasePath ?? "./nanosync-metadata.sqlite", "metadataDatabasePath");
  const objectStoragePath = validPath(input.objectStoragePath ?? "./nanosync-objects", "objectStoragePath");
  if (!hostname || /[\s\0/]/.test(hostname)) throw new TypeError("hostname is invalid");
  if (!isLoopback(hostname)) {
    if (input.acknowledgeInsecureNonLoopback !== true) throw new TypeError("non-loopback binding requires explicit trusted-network acknowledgement");
    warn("Nanosync is binding outside loopback without built-in transport encryption; use a trusted network or TLS proxy.");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError("port must be an integer from 1 through 65535");
  if (!Number.isSafeInteger(maximumObjectSize) || maximumObjectSize < 109 || maximumObjectSize > MAX_OBJECT_CIPHERTEXT_BYTES) throw new TypeError("maximumObjectSize is outside supported bounds");
  const externalOrigin = input.externalOrigin;
  if (externalOrigin !== undefined) {
    const url = new URL(externalOrigin);
    if (url.origin !== externalOrigin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) throw new TypeError("externalOrigin must be a secure origin (or loopback HTTP)");
  }
  const trustedProxyAddresses = Object.freeze([...(input.trustedProxyAddresses ?? [])]);
  if (trustedProxyAddresses.length && !externalOrigin?.startsWith("https://")) throw new TypeError("trusted proxies require an HTTPS externalOrigin");
  if (trustedProxyAddresses.some(address => !isIP(address))) throw new TypeError("trusted proxies must be exact IP addresses");
  return Object.freeze({ webUi: input.webUi === true, externalOrigin, trustedProxyAddresses, hostname, port, maximumObjectSize, metadataDatabasePath, objectStoragePath });
}

function validPath(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(`${name} is invalid`);
  return value;
}
export function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const parts = normalized.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

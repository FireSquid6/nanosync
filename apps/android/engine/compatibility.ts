import clone from "core-js-pure/actual/structured-clone.js";
import hasOwn from "core-js-pure/actual/object/has-own.js";
import { v4 } from "uuid";

// Android 12's original WebView predates these ECMAScript conveniences. Use
// maintained, targeted implementations; never replace WebCrypto or its CSPRNG.
export const nativeConveniences = {
  randomUUID: typeof globalThis.crypto?.randomUUID === "function",
  structuredClone: typeof globalThis.structuredClone === "function",
  objectHasOwn: typeof Object.hasOwn === "function",
};
if (!nativeConveniences.structuredClone) Object.defineProperty(globalThis, "structuredClone", { value: clone, configurable: true, writable: true });
if (!nativeConveniences.objectHasOwn) Object.defineProperty(Object, "hasOwn", { value: hasOwn, configurable: true, writable: true });

/** uuid's browser implementation uses native randomUUID or getRandomValues only. */
export function randomUUID(): string { return v4(); }

export function missingRuntimeFeatures(): string[] {
  const missing: string[] = [];
  if (!globalThis.crypto?.subtle) missing.push("crypto.subtle");
  if (typeof globalThis.crypto?.getRandomValues !== "function") missing.push("crypto.getRandomValues");
  if (typeof globalThis.ReadableStream !== "function") missing.push("ReadableStream");
  if (typeof globalThis.Request !== "function") missing.push("Request");
  if (typeof globalThis.Response !== "function") missing.push("Response");
  if (typeof globalThis.Headers !== "function") missing.push("Headers");
  if (typeof globalThis.TextEncoder !== "function") missing.push("TextEncoder");
  if (typeof globalThis.TextDecoder !== "function") missing.push("TextDecoder");
  if (typeof globalThis.structuredClone !== "function") missing.push("structuredClone");
  if (typeof Object.hasOwn !== "function") missing.push("Object.hasOwn");
  return missing;
}

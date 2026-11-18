import "./compatibility.ts";
import { install } from "./runtime.ts";
import type { NativeHost } from "./bridge.ts";
declare global { interface Window { Native: NativeHost; NanosyncNative?: NativeHost; Nanosync?: unknown; NanosyncBridge?: unknown } }
install(window.Native ?? window.NanosyncNative!, window);

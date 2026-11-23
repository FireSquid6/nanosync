import { baseUrl } from './url.ts';

export class SetupHttpError extends Error {
  constructor(readonly status: number) { super('Server request failed; check the connection and retry.'); }
}
/** Bound the entire exchange, including streaming bodies; never forward credentials on redirects. */
export async function setupRequest(url: string, path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl(url)}${path}`, {...init, headers, redirect:'error', signal:controller.signal});
    if (!response.ok) { await response.body?.cancel(); throw new SetupHttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (error instanceof SetupHttpError) throw error;
    throw new Error('Unable to contact server or invalid response; check the URL and network, then retry.');
  } finally { clearTimeout(timer); }
}

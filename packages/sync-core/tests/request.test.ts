import { expect, test } from "bun:test";
import { fetchWithDeadline } from "../src/request.ts";

test("deadline cancels a stalled response body after headers have arrived", async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const response = await fetchWithDeadline(async (_input, init) => {
    signal = init!.signal!;
    // Deliberately ignore the signal like a custom buffered native transport.
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  }, "https://local/v1/head", {}, undefined, 20);
  await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
  expect(signal!.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

test("pre-aborted owners never reach transport and raw streaming bodies remain intact", async () => {
  const owner = new AbortController(); owner.abort(new Error("stopped owner"));
  let calls = 0;
  await expect(fetchWithDeadline(async () => { calls++; return new Response(); }, "https://local/v1/head", {}, owner.signal))
    .rejects.toThrow("stopped owner");
  expect(calls).toBe(0);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } });
  const response = await fetchWithDeadline(async (input, init) => {
    expect(input).toBe("https://local/v1/objects/chunk/a");
    expect(init!.body).toBe(body);
    return new Response("done");
  }, "https://local/v1/objects/chunk/a", { method: "PUT", body, duplex: "half" } as RequestInit);
  expect(await response.text()).toBe("done");
});

test("completed bodies detach owner cancellation and clear their deadline", async () => {
  const owner = new AbortController(); let signal: AbortSignal | undefined;
  const response = await fetchWithDeadline(async (_input, init) => {
    signal = init!.signal!; return new Response("complete");
  }, "https://local/v1/head", {}, owner.signal, 20);
  expect(await response.text()).toBe("complete");
  owner.abort();
  await Bun.sleep(30);
  expect(signal!.aborted).toBe(false);
});

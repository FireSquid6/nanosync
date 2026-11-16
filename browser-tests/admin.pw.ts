import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let proc: ReturnType<typeof Bun.spawn>, directory: string, url: string;
const executable = process.env.NANOSYNC_TEST_BINARY
  ? [process.env.NANOSYNC_TEST_BINARY]
  : ["bun", "packages/cli/src/main.ts"];
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nanosync-browser-"));
  const env = { ...process.env, NANOSYNC_PASSWORD: "browser-owner-password" };
  const init = Bun.spawn(
    [
      ...executable,
      "server",
      "init",
      "--server-dir",
      directory,
      "--non-interactive",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  if ((await init.exited) !== 0)
    throw new Error(await new Response(init.stderr).text());
  url = "http://127.0.0.1:17943";
  proc = Bun.spawn(
    [
      ...executable,
      "server",
      "run",
      "--server-dir",
      directory,
      "--web-ui",
      "--port",
      "17943",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/admin")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Real server failed to start");
});
test.afterAll(async () => {
  proc?.kill();
  if (proc) await proc.exited;
  rmSync(directory, { recursive: true, force: true });
});
test("real browser encrypted provisioning, refresh retry, rename, danger dialog, logout and mobile keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url + "/admin");
  await page
    .getByLabel("Owner password", { exact: true })
    .fill("browser-owner-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vaults", exact: true }),
  ).toBeVisible();
  await page.getByLabel("New vault name").fill("notes");
  await page.getByRole("button", { name: "Prepare recovery" }).click();
  const secret = await page.getByTestId("recovery-secret").innerText();
  expect(secret.length).toBeGreaterThan(40);
  expect(
    await page.request.get(url + "/admin/api/vaults").then((r) => r.json()),
  ).toMatchObject({ vaults: [] });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/vaults"))
      requests.push(r.postData()!);
  });
  await page.getByLabel("I saved the recovery secret").check();
  // Acknowledged receipt survives refresh, but requires proof before publishing.
  await page.getByRole("button", { name: "Save encrypted receipt" }).click();
  await expect(page.getByLabel("Saved recovery secret")).toBeVisible();
  await page.reload();
  await page.getByLabel("Saved recovery secret").fill("wrong");
  await page.getByRole("button", { name: "Verify and publish" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByLabel("Saved recovery secret").fill(secret);
  await page.getByRole("button", { name: "Verify and publish" }).click();
  await expect(
    page.getByRole("heading", { name: "notes", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain(secret);
  expect(Object.keys(JSON.parse(requests[0]!)).sort()).toEqual([
    "frame",
    "genesisRevision",
    "name",
    "recoveryWrap",
    "vaultId",
  ]);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(secret);
  await page.getByRole("button", { name: "Rename notes" }).click();
  await page.getByLabel("Vault name", { exact: true }).fill("renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByRole("button", { name: "Delete renamed" }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Delete renamed" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Delete renamed" }).click();
  await page.getByLabel("Exact vault name").fill("renamed");
  await page
    .getByLabel("Owner password", { exact: true })
    .fill("browser-owner-password");
  await page.getByLabel("Exact vault name").fill("wrong-name");
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Exact vault name");
  await page.getByLabel("Exact vault name").fill("renamed");
  await page.getByLabel("Owner password", { exact: true }).fill("browser-owner-password");
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await expect(
    page.getByRole("heading", { name: "renamed", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("vault.deleted")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(
    page.getByRole("button", { name: "Log in", exact: true }),
  ).toBeVisible();
});

test("approve/deny comparison codes, active/revoked clients and lost creation response", async ({
  page,
}) => {
  const client = mkdtempSync(join(tmpdir(), "nanosync-ui-client-"));
  async function enroll(name: string) {
    const child = Bun.spawn(
      [
        ...executable,
        "client",
        "connections",
        "add",
        "--url",
        url,
        "--alias",
        name,
        "--device-name",
        name,
        "--client-dir",
        join(client, name),
        "--wait-ms",
        "0",
        "--non-interactive",
        "--json",
      ],
      {
        env: { ...process.env, NANOSYNC_PASSWORD: "browser-owner-password" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text(),
      stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    if (![0, 3].includes(code)) throw new Error(stderr);
    return { data: JSON.parse(stdout).data, stderr };
  }
  try {
    await page.goto(url + "/admin");
    await page
      .getByLabel("Owner password", { exact: true })
      .fill("browser-owner-password");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    const first = await enroll("keyboard-device"),
      second = await enroll("denied-device");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const code = await page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", {
          name: "keyboard-device",
          exact: true,
        }),
      })
      .locator("code")
      .innerText();
    expect(first.stderr).toContain(code);
    await page
      .getByRole("button", { name: "Approve keyboard-device", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Revoke keyboard-device", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Deny denied-device", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Deny denied-device", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Revoke keyboard-device", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "does not erase downloaded ciphertext, plaintext or keys",
    );
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Confirm revocation" }).click();
    await expect(
      page.getByRole("button", { name: "Revoke keyboard-device", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("device.revoked")).toBeVisible();
    await page.getByLabel("New vault name").fill("lost-response");
    await page.getByRole("button", { name: "Prepare recovery" }).click();
    const secret = await page.getByTestId("recovery-secret").innerText();
    await page.getByLabel("I saved the recovery secret").check();
    await page.getByRole("button", { name: "Save encrypted receipt" }).click();
    let request = "";
    await page.route("**/admin/api/vaults", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      request = route.request().postData()!;
      await route.fetch();
      await route.abort("failed");
    });
    await page.getByLabel("Saved recovery secret").fill(secret);
    await page.getByRole("button", { name: "Verify and publish" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain(secret);
    await page.unroute("**/admin/api/vaults");
    await page.reload();
    await page.getByLabel("Saved recovery secret").fill(secret);
    const replay = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/vaults"),
    );
    await page.getByRole("button", { name: "Verify and publish" }).click();
    expect((await replay).postData()).toBe(request);
    await expect(
      page.getByRole("heading", { name: "lost-response", exact: true }),
    ).toHaveCount(1);
    expect(
      await page.request
        .get(url + "/admin/api/vaults")
        .then((r) => r.json())
        .then((r) => r.vaults.length),
    ).toBe(1);
  } finally {
    rmSync(client, { recursive: true, force: true });
  }
});

test("exact embedded asset allowlist, security headers and opt-in routing", async ({
  page,
}) => {
  const html = await page.request.get(url + "/admin");
  expect(html.headers()["cache-control"]).toBe("no-store");
  expect(html.headers()["content-security-policy"]).toContain(
    "script-src 'self'",
  );
  expect(html.headers()["referrer-policy"]).toBe("no-referrer");
  await page.goto(url + "/admin");
  const assets = await page
    .locator("script[src],link[rel=stylesheet]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("src") ?? n.getAttribute("href")!),
    );
  expect(assets).toHaveLength(2);
  for (const asset of assets) {
    expect(asset).toMatch(/^\/admin\/assets\/admin-[a-zA-Z0-9]+\.(js|css)$/);
    const response = await page.request.get(url + asset);
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toContain("immutable");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
  expect(
    (await page.request.get(url + "/admin/assets/not-allowed.js")).status(),
  ).toBe(404);
  expect((await page.request.get(url + "/admin/files")).status()).toBe(404);
  const disabledDirectory = mkdtempSync(
    join(tmpdir(), "nanosync-disabled-ui-"),
  );
  const init = Bun.spawn(
    [
      ...executable,
      "server",
      "init",
      "--server-dir",
      disabledDirectory,
      "--non-interactive",
    ],
    {
      env: { ...process.env, NANOSYNC_PASSWORD: "disabled-password" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await init.exited).toBe(0);
  const disabled = Bun.spawn(
    [
      ...executable,
      "server",
      "run",
      "--server-dir",
      disabledDirectory,
      "--port",
      "17944",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        response = await fetch("http://127.0.0.1:17944/admin");
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(response?.status).toBe(404);
    for (const path of [...assets, "/admin/api/session"])
      expect((await fetch("http://127.0.0.1:17944" + path)).status).toBe(404);
  } finally {
    disabled.kill();
    await disabled.exited;
    rmSync(disabledDirectory, { recursive: true, force: true });
  }
});

test('two tabs cannot overwrite an acknowledged encrypted receipt', async ({page,context})=>{
 await page.goto(url+'/admin');
 await page.getByLabel('Owner password',{exact:true}).fill('browser-owner-password');
 await page.getByRole('button',{name:'Log in',exact:true}).click();
 const other=await context.newPage();await other.goto(url+'/admin');
 for(const [tab,name] of [[page,'first-tab'],[other,'second-tab']] as const){
  await tab.getByLabel('New vault name').fill(name);
  await tab.getByRole('button',{name:'Prepare recovery'}).click();
  await tab.getByLabel('I saved the recovery secret').check();
 }
 await page.getByRole('button',{name:'Save encrypted receipt'}).click();
 await expect(page.getByLabel('Saved recovery secret')).toBeVisible();
 await other.getByRole('button',{name:'Save encrypted receipt'}).click();
 await expect(other.getByRole('alert')).toContainText('Another tab saved a creation receipt');
 await other.reload();
 await expect(other.getByRole('heading',{name:'Create first-tab',exact:true})).toBeVisible();
 const receipt=await page.evaluate(()=>localStorage.getItem('nanosync-encrypted-creation-v1'));
 expect(JSON.parse(receipt!).name).toBe('first-tab');
});

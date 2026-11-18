import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let proc: ReturnType<typeof Bun.spawn>, directory: string, url: string;
const executable = process.env.NANOSYNC_TEST_BINARY
  ? [process.env.NANOSYNC_TEST_BINARY]
  : ["bun", "packages/cli/src/main.ts"];
// Assert page isolation as well as the URL: navigation must not just scroll
// between sections of the old single-page dashboard.
async function expectAdminPage(page: Page, section: "Clients" | "Vaults" | "Activity") {
  await expect(page).toHaveURL(url + "/admin/" + section.toLowerCase());
  await expect(page).toHaveTitle(section + " · Nanosync administration");
  for (const [name, visible] of [
    ["Clients", section === "Clients"],
    ["Pending requests", section === "Clients"],
    ["Vaults", section === "Vaults"],
    ["Recent activity", section === "Activity"],
  ] as const) {
    const heading = page.getByRole("heading", { name, exact: true });
    if (visible) await expect(heading).toBeVisible();
    else await expect(heading).toHaveCount(0);
  }
  if (section !== "Vaults") await expect(page.getByLabel("New vault name")).toHaveCount(0);
}

async function navigate(page: Page, section: "Clients" | "Vaults" | "Activity") {
  await page.getByRole("navigation", { name: "Administration" })
    .getByRole("link", { name: section, exact: true }).click();
  await expectAdminPage(page, section);
  await expect(page.locator(".admin-page")).toBeFocused();
}

// Isolate server state and password-verification quotas between workflows.
test.beforeEach(async () => {
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
test.afterEach(async () => {
  proc?.kill();
  if (proc) await proc.exited;
  rmSync(directory, { recursive: true, force: true });
});
test("protected deep link survives login, refresh and browser history", async ({ page }) => {
  let sessionLoads = 0;
  page.on("request", request => {
    if (request.method() === "GET" && request.url().endsWith("/admin/api/session")) sessionLoads++;
  });
  await page.goto(url + "/admin/vaults");
  await expect(page).toHaveURL(/\/admin\/login(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByLabel("New vault name")).toHaveCount(0);
  await page.getByLabel("Owner password", { exact: true }).fill("browser-owner-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expectAdminPage(page, "Vaults");
  await page.reload();
  await expectAdminPage(page, "Vaults");
  await navigate(page, "Clients");
  await page.reload();
  await expectAdminPage(page, "Clients");
  await navigate(page, "Activity");
  await page.reload();
  await expectAdminPage(page, "Activity");
  const loadsBeforeHistory = sessionLoads;
  await page.goBack();
  await expectAdminPage(page, "Clients");
  await page.goBack();
  await expectAdminPage(page, "Vaults");
  await page.goForward();
  await expectAdminPage(page, "Clients");
  await page.goForward();
  await expectAdminPage(page, "Activity");
  expect(sessionLoads).toBe(loadsBeforeHistory);
  await page.goto(url + "/admin");
  await expectAdminPage(page, "Clients");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(url + "/admin/login");
  await expect(page).toHaveTitle("Log in · Nanosync administration");
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await page.goto(url + "/admin/activity");
  await expect(page).toHaveURL(/\/admin\/login(?:\?.*)?$/);
  await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toHaveCount(0);
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
  await expectAdminPage(page, "Clients");
  await navigate(page, "Vaults");
  await page.getByLabel("New vault name").fill("notes");
  await page.getByRole("button", { name: "Prepare recovery key" }).click();
  const secret = await page.getByTestId("recovery-secret").innerText();
  expect(secret.length).toBeGreaterThan(40);
  await navigate(page, "Clients");
  await expect(page.getByTestId("recovery-secret")).toHaveCount(0);
  await navigate(page, "Vaults");
  await expect(page.getByTestId("recovery-secret")).toHaveText(secret);
  expect(
    await page.request.get(url + "/admin/api/vaults").then((r) => r.json()),
  ).toMatchObject({ vaults: [] });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/vaults"))
      requests.push(r.postData()!);
  });
  await page.getByLabel("I saved the vault recovery key").check();
  // Acknowledged receipt survives refresh, but requires proof before publishing.
  await page.getByRole("button", { name: "Save encrypted receipt" }).click();
  await expect(page.getByLabel("Vault recovery key", { exact: true })).toBeVisible();
  await navigate(page, "Activity");
  await navigate(page, "Vaults");
  await expect(page.getByLabel("Vault recovery key", { exact: true })).toBeVisible();
  await expect(page.getByTestId("recovery-secret")).toHaveCount(0);
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByLabel("Vault recovery key", { exact: true })).toHaveCount(0);
  await page.getByLabel("Owner password", { exact: true }).fill("browser-owner-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expectAdminPage(page, "Vaults");
  await expect(page.getByLabel("Vault recovery key", { exact: true })).toBeVisible();
  await page.reload();
  await expectAdminPage(page, "Vaults");
  await page.getByLabel("Vault recovery key", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Verify and publish" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByLabel("Vault recovery key", { exact: true }).fill(secret);
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await navigate(page, "Activity");
  await expect(page.getByText("vault.deleted", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(url + "/admin/login");
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
    await expectAdminPage(page, "Clients");
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
    await navigate(page, "Activity");
    await expect(page.getByText("device.revoked", { exact: true })).toBeVisible();
    await navigate(page, "Vaults");
    await page.getByLabel("New vault name").fill("lost-response");
    await page.getByRole("button", { name: "Prepare recovery key" }).click();
    const secret = await page.getByTestId("recovery-secret").innerText();
    await page.getByLabel("I saved the vault recovery key").check();
    await page.getByRole("button", { name: "Save encrypted receipt" }).click();
    let request = "";
    await page.route("**/admin/api/vaults", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      request = route.request().postData()!;
      await route.fetch();
      await route.abort("failed");
    });
    await page.getByLabel("Vault recovery key", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "Verify and publish" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain(secret);
    await page.unroute("**/admin/api/vaults");
    await page.reload();
    await page.getByLabel("Vault recovery key", { exact: true }).fill(secret);
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
  const pages = ["/admin", "/admin/login", "/admin/clients", "/admin/vaults", "/admin/activity"];
  for (const path of pages) {
    const response = await page.request.get(url + path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain("text/html");
    expect(await response.text(), path).toMatch(/<!doctype html>/i);
  }
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
    for (const path of [...pages, ...assets, "/admin/api/session"])
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
 // Wait for login to commit its cookie before navigating the second tab.
 await expectAdminPage(page, 'Clients');
 await page.goto(url+'/admin/vaults');
 await expectAdminPage(page, 'Vaults');
 const other=await context.newPage();await other.goto(url+'/admin/vaults');
 await expectAdminPage(other, 'Vaults');
 for(const [tab,name] of [[page,'first-tab'],[other,'second-tab']] as const){
  await tab.getByLabel('New vault name').fill(name);
  await tab.getByRole('button',{name:'Prepare recovery key'}).click();
  await tab.getByLabel('I saved the vault recovery key').check();
 }
 await page.getByRole('button',{name:'Save encrypted receipt'}).click();
 await expect(page.getByLabel('Vault recovery key', {exact:true})).toBeVisible();
 await other.getByRole('button',{name:'Save encrypted receipt'}).click();
 await expect(other.getByRole('alert')).toContainText('Another tab saved a creation receipt');
 await other.reload();
 await expect(other.getByRole('heading',{name:'Create first-tab',exact:true})).toBeVisible();
 const receipt=await page.evaluate(()=>localStorage.getItem('nanosync-encrypted-creation-v1'));
 expect(JSON.parse(receipt!).name).toBe('first-tab');
});

test("Field Guide themes, responsive screens and dialog remain accessible", async ({ page }, testInfo) => {
  await page.goto(url + "/admin");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(40, 40, 40)");
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.reload();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByLabel("Owner password", { exact: true }).fill("browser-owner-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expectAdminPage(page, "Clients");
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const section of ["Clients", "Vaults", "Activity"] as const) {
        if (!page.url().endsWith(`/admin/${section.toLowerCase()}`)) await navigate(page, section);
        await expectAdminPage(page, section);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${section}-${theme}-${width}.png`), fullPage: true });
      }
    }
  }
  await navigate(page, "Vaults");
  await page.getByLabel("New vault name").fill("theme-check");
  await page.getByRole("button", { name: "Prepare recovery key" }).click();
  const secret = await page.getByTestId("recovery-secret").innerText();
  await page.getByLabel("I saved the vault recovery key").check();
  await page.getByRole("button", { name: "Save encrypted receipt" }).click();
  await page.getByLabel("Vault recovery key", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Verify and publish" }).click();
  await expect(page.getByRole("heading", { name: "theme-check", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete theme-check", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(40, 40, 40)");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("delete-dialog-dark.png"), fullPage: true });
});

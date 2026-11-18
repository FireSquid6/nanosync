import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.env.NANOSYNC_TEST_BINARY
  ? [process.env.NANOSYNC_TEST_BINARY]
  : ["bun", "packages/cli/src/main.ts"];

// Public seams: actual CLI subprocesses, served browser UI/API, and user files.
// No repository or database access: the same journey also runs against the binary.
test("local init and creation → CLI enrollment/browser approval → two replicas → revoke/delete retain work", async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), "nanosync-journey-"));
  const server = join(root, "server"), recovery = join(root, "recovery");
  const password = "journey-owner-password";
  async function cli(args: string[], extraEnv: Record<string, string> = {}) {
    const child = Bun.spawn([...executable, ...args, "--non-interactive", "--json"], {
      env: { ...process.env, NANOSYNC_PASSWORD: password, ...extraEnv }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exit };
  }
  let runtime: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect((await cli(["server", "init", "--server-dir", server])).exit).toBe(0);
    const created = await cli(["server", "vaults", "create", "--server-dir", server, "--name", "local-vault", "--recovery-output", recovery]);
    expect(created.exit, created.stderr).toBe(0);
    const localId = JSON.parse(created.stdout).data.vaultId;
    const secret = readFileSync(recovery, "utf8").trim();
    expect(created.stdout + created.stderr).not.toContain(secret);
    const url = "http://127.0.0.1:17945";
    runtime = Bun.spawn([...executable, "server", "run", "--server-dir", server, "--web-ui", "--port", "17945"], { stdout: "pipe", stderr: "pipe" });
    await expect.poll(async () => { try { return (await fetch(url + "/admin")).status; } catch { return 0; } }).toBe(200);
    await page.goto(url + "/admin");
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page).toHaveURL(url + "/admin/clients");
    await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Administration" });
    await navigation.getByRole("link", { name: "Vaults", exact: true }).click();
    await expect(page.getByRole("heading", { name: "local-vault", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pending requests", exact: true })).toHaveCount(0);
    await navigation.getByRole("link", { name: "Clients", exact: true }).click();

    const clients = [join(root, "client-a"), join(root, "client-b")];
    const replicas = [join(root, "replica-a"), join(root, "replica-b")];
    for (let i = 0; i < 2; i++) {
      mkdirSync(replicas[i]!);
      const args = ["client", "connections", "add", "--url", url, "--alias", "home", "--device-name", `journey-${i}`, "--client-dir", clients[i]!, "--wait-ms", "0"];
      const pending = await cli(args);
      expect(pending.exit, pending.stderr).toBe(3);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const article = page.getByRole("article").filter({ has: page.getByRole("heading", { name: `journey-${i}`, exact: true }) });
      expect(pending.stderr).toContain(await article.locator("code").innerText());
      await page.getByRole("button", { name: `Approve journey-${i}`, exact: true }).click();
      const approved = await cli(args);
      expect(approved.exit, approved.stderr).toBe(0);
      expect(approved.stdout + approved.stderr).not.toContain(password);
      const connected = await cli(["client", "vaults", "connect", "--server", "home", "--vault", localId, "--path", replicas[i]!, "--client-dir", clients[i]!, "--recovery-file", recovery]);
      expect(connected.exit, connected.stderr).toBe(0);
    }
    writeFileSync(join(replicas[0]!, "shared.txt"), "from the first replica\n");
    const sync = (i: number) => cli(["client", "sync", "--path", replicas[i]!, "--client-dir", clients[i]!]);
    expect((await sync(0)).exit).toBe(0);
    expect((await sync(1)).exit).toBe(0);
    expect(readFileSync(join(replicas[1]!, "shared.txt"), "utf8")).toBe("from the first replica\n");
    writeFileSync(join(replicas[1]!, "second.txt"), "from the second replica\n");
    expect((await sync(1)).exit).toBe(0);
    expect((await sync(0)).exit).toBe(0);
    expect(readFileSync(join(replicas[0]!, "second.txt"), "utf8")).toBe("from the second replica\n");

    await navigation.getByRole("link", { name: "Vaults", exact: true }).click();
    await expect(page).toHaveURL(url + "/admin/vaults");
    await page.getByLabel("New vault name").fill("browser-vault");
    await page.getByRole("button", { name: "Prepare recovery key" }).click();
    const browserSecret = await page.getByTestId("recovery-secret").innerText();
    await page.getByLabel("I saved the vault recovery key").check();
    await page.getByRole("button", { name: "Save encrypted receipt" }).click();
    await page.getByLabel("Vault recovery key", { exact: true }).fill(browserSecret);
    await page.getByRole("button", { name: "Verify and publish" }).click();
    await expect(page.getByRole("heading", { name: "browser-vault", exact: true })).toBeVisible();

    writeFileSync(join(replicas[0]!, "unsynced.txt"), "retained after revocation\n");
    writeFileSync(join(replicas[1]!, "unsynced.txt"), "retained after deletion\n");
    await navigation.getByRole("link", { name: "Clients", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Revoke journey-0", exact: true }).click();
    await page.getByRole("button", { name: "Confirm revocation" }).click();
    const revoked = await sync(0);
    expect(revoked.exit).toBe(5);
    expect(revoked.stderr).toContain('"code":"UNAUTHORIZED"');
    expect(revoked.stdout).toBe("");
    await navigation.getByRole("link", { name: "Vaults", exact: true }).click();
    await page.getByRole("button", { name: "Delete local-vault", exact: true }).click();
    await page.getByLabel("Exact vault name").fill("local-vault");
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Permanently delete" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "local-vault", exact: true })).toHaveCount(0);
    const deleted = await sync(1);
    expect(deleted.exit).toBe(5);
    expect(deleted.stderr).toContain('"code":"VAULT_DELETED"');
    expect(deleted.stdout).toBe("");
    for (let i = 0; i < 2; i++) {
      expect(readFileSync(join(replicas[i]!, "shared.txt"), "utf8")).toBe("from the first replica\n");
      expect(readFileSync(join(replicas[i]!, "second.txt"), "utf8")).toBe("from the second replica\n");
      expect(readFileSync(join(replicas[i]!, "unsynced.txt"), "utf8")).toBe(i === 0 ? "retained after revocation\n" : "retained after deletion\n");
    }
    await expect(page.getByRole("heading", { name: "browser-vault", exact: true })).toBeVisible();
    await navigation.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page).toHaveURL(url + "/admin/activity");
    await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();
    await expect(page.getByText("vault.deleted", { exact: true })).toBeVisible();
    await expect(page.getByText("device.revoked", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toHaveCount(0);
    const activity = await page.request.get(url + "/admin/api/activity").then(r => r.json());
    expect(activity).toMatchObject({ activity: expect.arrayContaining([
      expect.objectContaining({ action: "vault.created", origin: "server-local", targetId: localId, occurredAtMs: expect.any(Number) }),
      expect.objectContaining({ action: "vault.created", origin: "browser" }),
      expect.objectContaining({ action: "vault.deleted", origin: "browser", targetId: localId, occurredAtMs: expect.any(Number) }),
      expect.objectContaining({ action: "enrollment.approved", origin: "browser" }),
      expect.objectContaining({ action: "device.revoked", origin: "browser" }),
    ]) });
    expect(JSON.stringify(activity)).not.toContain(secret);
    expect(JSON.stringify(activity)).not.toContain(browserSecret);
    expect(JSON.stringify(activity)).not.toContain("shared.txt");
  } finally {
    runtime?.kill();
    if (runtime) await runtime.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

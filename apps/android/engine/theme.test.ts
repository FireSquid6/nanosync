import { expect, test } from "bun:test";

const stylesheet = await Bun.file(
  new URL("../../../packages/ui-theme/styles.css", import.meta.url),
).text();

for (const [mode, selector, directory] of [
  ["light", /:root\s*\{([^}]+)}/, "values"],
  ["dark", /:root\[data-theme="dark"\]\s*\{([^}]+)}/, "values-night"],
] as const) {
  test(`Android ${mode} palette matches the website and admin theme`, async () => {
    const block = stylesheet.match(selector)?.[1];
    expect(block).toBeDefined();
    const shared = new Map([...block!.matchAll(/--fg-(\w+):\s*(#[a-f\d]{6})/g)]
      .map(([, name, color]) => [name, color]));
    const resources = await Bun.file(
      new URL(`../app/src/main/res/${directory}/colors.xml`, import.meta.url),
    ).text();
    const android = new Map([...resources.matchAll(/<color name="fg_(\w+)">([^<]+)<\/color>/g)]
      .map(([, name, color]) => [name, color]));
    expect(shared.size).toBeGreaterThan(0);
    expect(android).toEqual(shared);
  });
}

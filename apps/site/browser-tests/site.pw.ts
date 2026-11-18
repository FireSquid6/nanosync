import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('real routes, documentation search, code copying, headings and history', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/docs\/installation$/);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('code .hljs-comment').first()).toBeVisible();
  await page.getByRole('button', { name: 'Copy code', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  const search = page.getByRole('searchbox');
  await search.fill('recovery');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('link', { name: 'Security and recovery' })).toBeVisible();
  await results.getByRole('link', { name: 'Security and recovery' }).click();
  await expect(page).toHaveURL(/\/docs\/security$/);
  await expect(search).toHaveValue('');
  const anchor = page.locator('h2 a').first();
  await anchor.click();
  await expect(page).toHaveURL(/\/docs\/security#/);
  await page.reload();
  await expect(page.locator('h1')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Documentation', exact: true }).getByRole('link', { name: 'Introduction', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/introduction$/);
  await page.getByRole('link', { name: /Installation →/ }).click();
  await expect(page).toHaveURL(/\/docs\/installation$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/docs\/introduction$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/docs\/installation$/);
  for (const route of ['pricing', 'dashboard']) {
    await page.goto(`/${route}`);
    await expect(page.getByText('self hosted only--managed nanosync servers coming soon', { exact: true })).toBeVisible();
  }
  const response = await page.goto('/docs/not-a-guide');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('site branding, home features and sync animation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('figure', { name: 'Two-machine file sync demo' })).toBeVisible();
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  for (const route of ['/', '/dashboard', '/pricing', '/docs/introduction']) {
    await page.goto(route);
    await expect(page).toHaveTitle('nanosync');
    await expect(page.locator('footer')).toContainText('built by Jonathan Deiss');
  }
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(page.getByText('self hosted only--managed nanosync servers coming soon', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Uncomplicate file sync');
  await expect(page.getByRole('checkbox')).toHaveCount(6);
  for (const feature of ['Two-way sync', 'End-to-end encryption', 'Self-hostable', 'CLI', 'Android 12+ app (debug validation build; no iOS app)']) {
    await expect(page.getByRole('checkbox', { name: feature, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: feature, exact: true })).toBeDisabled();
  }
  for (const feature of ['Desktop App']) {
    await expect(page.getByRole('checkbox', { name: feature, exact: true })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: feature, exact: true })).toBeDisabled();
  }
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  const pause = page.getByRole('button', { name: 'Pause animation' });
  await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-line').last()).toHaveCSS('animation-play-state', 'paused');
  await page.locator('.terminal-panes').evaluate(element => {
    for (const animation of element.getAnimations({ subtree: true })) animation.currentTime = 30_000;
  });
  await expect(page.locator('.terminal-line').last()).toHaveCSS('clip-path', 'inset(0px 0% 0px 0px)');
  await expect(page.locator('.terminal-pane').last()).toContainText('- Build something small.');
  await page.getByRole('button', { name: 'Replay animation' }).click();
  await expect(pause).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.terminal-line').last()).toHaveCSS('clip-path', 'inset(0px 100% 0px 0px)');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.terminal-line').last()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.terminal-line').last()).toHaveCSS('clip-path', 'none');
  await expect(pause).toBeHidden();
});

test('every guide has working content links and accessible light/dark content', async ({ page }) => {
  for (const slug of ['introduction', 'installation', 'first-sync', 'server', 'administration', 'ignore-rules', 'troubleshooting', 'security']) {
    const response = await page.goto(`/docs/${slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('article h1')).toHaveCount(1);
    const links = await page.locator('article a').evaluateAll(elements => elements.map(element => element.getAttribute('href') ?? ''));
    for (const href of links) {
      if (!href.startsWith('https://')) expect(href).not.toMatch(/\.md(?:#|$)/);
      if (href.startsWith('/docs/')) expect((await page.request.get(href)).status()).toBe(200);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  for (const route of ['/', '/docs/first-sync', '/pricing', '/dashboard']) {
    for (const theme of ['light', 'dark']) {
      await page.goto(route);
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    }
  }
});

test('mobile documentation navigation is keyboard accessible and closes after selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docs');
  const toggle = page.getByRole('button', { name: 'Browse documentation' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Documentation', exact: true }).getByRole('link', { name: 'Installation', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#doc-content')).toBeFocused();
  await expect(page.locator('h1')).toBeVisible();
});

test('theme follows the system, persists explicit selection, and survives disabled storage', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(40, 40, 40)');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.reload();
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 241, 199)');
  await page.getByRole('link', { name: 'docs', exact: true }).click();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 241, 199)');
  await page.getByLabel('Theme', { exact: true }).selectOption('system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(40, 40, 40)');
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('disabled'); } }));
  await page.reload();
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(251, 241, 199)');
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 700, 701, 1440]) {
    test(`${theme} at ${width}px has no horizontal overflow`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/', '/docs/installation', '/dashboard']) {
        await page.goto(route);
        await page.getByLabel('Theme', { exact: true }).selectOption(theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-${theme}-${width}.png`), fullPage: true });
      }
    });
  }
}

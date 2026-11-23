import AxeBuilder from '@axe-core/playwright';
import { test, expect, openApp } from './fixtures';

test('core surfaces expose named controls without serious accessibility violations', async ({ page }) => {
  await openApp(page);
  for (const name of ['Folders', 'Conflicts', 'Connections', 'Settings']) {
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? '')), name).toEqual([]);
  }
});

import { test, expect } from '@playwright/test';

test('initial canvas visual inspection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await expect(page.locator('.workflow-node').first()).toBeVisible();
  await page.screenshot({ path: '../docs/screenshots/01-workflow-editor.png', fullPage: true });
  console.log(
    'Canvas bounds:',
    await page.locator('.workflow-node').evaluateAll((nodes) =>
      nodes.map((n) => ({
        id: n.getAttribute('data-node-id'),
        width: n.getBoundingClientRect().width,
        x: n.getBoundingClientRect().x,
        y: n.getBoundingClientRect().y,
      })),
    ),
  );
  console.log('Browser errors:', errors);
  const paths = page.locator('.gedit-flow-activity-edge svg g>path:first-child');
  await expect(paths).toHaveCount(3);
  for (const path of await paths.all()) await expect(path).toHaveAttribute('d', /^M.+/);
  expect(errors).toEqual([]);
});

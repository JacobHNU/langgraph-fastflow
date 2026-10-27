import { expect, test } from '@playwright/test';

test('record a completed order workflow from the configured live model', async ({ page }) => {
  test.skip(
    !process.env.LIVE_DEMO_URL,
    'Set LIVE_DEMO_URL to a completed run; this test never starts a model call.',
  );
  await page.goto(process.env.LIVE_DEMO_URL!);
  await expect(page.locator('.result-overview')).toContainText('执行成功');
  await expect(page.locator('.analysis-result')).toContainText('CUST-1001');
  await expect(page.locator('.analysis-result')).toContainText('在线模型');
  await expect(page.locator('.workflow-node')).toHaveCount(6);
  const separator = page.getByRole('separator', { name: '调整执行结果高度' });
  await separator.focus();
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowUp');
  await page.getByTitle('适应画布').click();
  await page.screenshot({
    path: '../docs/screenshots/22-order-summary-live-model.png',
    fullPage: true,
  });
});

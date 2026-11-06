import { test, expect } from '@playwright/test';
import { TEST_PASSWORD, TEST_USERNAME } from './fixtures';

test('seven-node integration uses the saved live model and records an isolated model debug run', async ({
  page,
}) => {
  test.skip(
    !process.env.LIVE_M11_VERIFY,
    'Requires the isolated live verification instance with a configured model.',
  );
  test.setTimeout(240000);
  const login = await page.request.post('/api/auth/login', {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const session = await login.json();
  await page.context().setExtraHTTPHeaders({ 'X-CSRF-Token': session.csrf_token });
  await page.goto('/?workspace=ws_legacy&workflow=order-integration-lab');
  await expect(page.locator('.workflow-node')).toHaveCount(7);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toContainText('CUST-1001', { timeout: 120000 });
  const runId = new URL(page.url()).searchParams.get('run')!;
  const before = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(before.model_mode).toBe('openai');
  expect(before.usage).toEqual({ model_calls: 1, tool_calls: 1 });
  expect(before.node_results.n_transform.order_ids).toEqual(['ORD-1001', 'ORD-1002', 'ORD-1003']);
  await page.getByLabel('反馈', { exact: true }).fill('已核对真实模型摘要和字段转换结果');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  await page.getByRole('separator', { name: '调整执行结果高度' }).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
  await page.getByTitle('适应画布').click();
  await page.screenshot({ path: '../docs/screenshots/35-m11-live-completed.png', fullPage: true });
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/runs/${runId}`)).json()).evaluation_status,
      { timeout: 90000 },
    )
    .not.toMatch(/^(PENDING|RUNNING)$/);
  const completed = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(completed.evaluation_status).toBe('PASSED');
  await page.goto('/?workspace=ws_legacy&workflow=order-integration-lab');
  await page.locator('.workflow-node[data-node-id="n_summary"]').click();
  await page.getByText('节点试跑', { exact: true }).click();
  await page
    .getByLabel('调试输入 JSON')
    .fill(
      JSON.stringify({ customer_id: 'CUST-1001', orders: [{ id: 'ORD-DEBUG', status: 'paid' }] }),
    );
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('summary', { timeout: 120000 });
  await expect(page.locator('.node-debug [role="status"]')).toContainText('执行成功');
  await page.getByText(/调试事件与模型日志（/).click();
  await expect(page.locator('.node-debug')).toContainText('model.completed');
  console.log(
    JSON.stringify({
      runId,
      status: completed.status,
      evaluation: completed.evaluation_status,
      model: Object.values(before.resolved_bindings.models).map((m: any) => m.config.model),
      usage: completed.usage,
    }),
  );
});

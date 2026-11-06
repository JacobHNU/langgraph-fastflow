import { test, expect } from './fixtures';

test('transform mapping and isolated node debug show inputs outputs events and evidence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const original = await (await page.request.get('/api/agents/order-integration-lab')).json();
  await page.goto('/?workflow=order-integration-lab');
  await expect(page.locator('.workflow-node')).toHaveCount(7);
  await page.locator('.workflow-node[data-node-id="n_transform"]').click();
  await expect(page.getByLabel('order_ids 转换路径', { exact: true })).toHaveValue(
    'response.data.orders.*.id',
  );
  await expect(page.getByLabel('source 默认值', { exact: true })).toHaveValue('"本地订单服务"');
  await page.getByText('节点试跑', { exact: true }).click();
  await page.getByLabel('调试输入 JSON', { exact: true }).fill(
    JSON.stringify({
      response: {
        data: { customer_id: 'CUST-1001', orders: [{ id: 'ORD-DEBUG', status: 'paid' }] },
      },
    }),
  );
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('ORD-DEBUG', { timeout: 15000 });
  await page.getByText(/调试事件与模型日志（/).click();
  await expect(page.locator('.node-debug')).toContainText('node.completed');
  await page.getByText(/调试证据（/).click();
  await expect(page.locator('.node-debug')).toContainText('证据 #1');
  await page.getByText(/调试事件与模型日志（/).click();
  await page.locator('.node-debug').scrollIntoViewIfNeeded();
  expect(await (await page.request.get('/api/agents/order-integration-lab')).json()).toEqual(
    original,
  );
  await page.screenshot({ path: '../docs/screenshots/31-m11-node-debug.png', fullPage: true });
  await page.getByRole('link', { name: '查看调试运行快照' }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功');
  await expect(page.getByRole('button', { name: '试跑节点', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('model node debug records the configured model request and response', async ({ page }) => {
  await page.goto('/?workflow=order-integration-lab');
  await page.locator('.workflow-node[data-node-id="n_summary"]').click();
  await page.getByText('节点试跑', { exact: true }).click();
  await page
    .getByLabel('调试输入 JSON', { exact: true })
    .fill(JSON.stringify({ customer_id: 'CUST-1001', orders: [] }));
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('CUST-1001', { timeout: 15000 });
  await page.getByText(/调试事件与模型日志（/).click();
  await expect(page.locator('.node-debug')).toContainText('model.called');
  await expect(page.locator('.node-debug')).toContainText('model.completed');
});

test('seven-node POST transform model verify human output runs in LangGraph', async ({ page }) => {
  await page.goto('/?workflow=order-integration-lab');
  await expect(page.locator('.workflow-node')).toHaveCount(7);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toContainText('3 笔订单', { timeout: 20000 });
  const runId = new URL(page.url()).searchParams.get('run')!;
  const before = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(before.node_results.n_transform.order_ids).toEqual(['ORD-1001', 'ORD-1002', 'ORD-1003']);
  expect(before.usage).toEqual({ model_calls: 1, tool_calls: 1 });
  await page.getByLabel('反馈', { exact: true }).fill('已核对转换结果和订单摘要');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  const run = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(Object.keys(run.node_results)).toHaveLength(7);
  expect(run.result.order_ids).toEqual(before.node_results.n_transform.order_ids);
  expect(run.result.approved).toBe(true);
  await page.screenshot({ path: '../docs/screenshots/32-m11-completed.png', fullPage: true });
});

test('HTTP connection UI saves parameter destinations extraction and header authentication', async ({
  page,
}) => {
  await page.goto('/?settings=models');
  await page.getByRole('button', { name: 'HTTP 连接', exact: true }).click();
  await page.getByRole('button', { name: '新建连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('连接认证方式').selectOption('api_key');
  await dialog.getByLabel('API Key 请求头名称').fill('X-Service-Key');
  await dialog.getByLabel('资源凭据').fill('m11-browser-private-token');
  await dialog.getByLabel('HTTP 请求方法').selectOption('POST');
  await dialog.getByRole('checkbox', { name: /确认此 POST/ }).check();
  await dialog.getByLabel('POST 路径').fill('/search');
  await dialog.getByLabel('id 参数位置').selectOption('body');
  await dialog.getByLabel('响应提取路径').fill('payload.items');
  await page.screenshot({ path: '../docs/screenshots/33-m11-http-settings.png', fullPage: true });
  await dialog.getByRole('button', { name: '保存版本' }).click();
  await expect(dialog).toHaveCount(0);
  const connections = await (await page.request.get('/api/connections')).json();
  const saved = connections.find((c: any) => c.name === '新 HTTP 连接');
  expect(saved.auth_header).toBe('X-Service-Key');
  expect(saved.operations[0].parameters.id).toEqual({ location: 'body', name: 'id' });
  expect(saved.operations[0].response_path).toEqual(['payload', 'items']);
  expect(saved.operations[0].read_only_confirmed).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('m11-browser-private-token');
});

test('mobile dark transform and debug controls fit the inspector', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.put('/api/me/preferences', {
    data: { theme: 'dark', accent: 'teal', default_workspace_id: 'ws_legacy' },
  });
  await page.goto('/?workflow=order-integration-lab');
  await page.locator('.workflow-node[data-node-id="n_transform"]').click();
  await expect(page.getByLabel('order_ids 转换路径', { exact: true })).toBeVisible();
  await page.getByText('节点试跑', { exact: true }).click();
  await page.getByLabel('调试输入 JSON').fill('{}');
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.locator('.node-debug')).toContainText('执行失败', { timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../docs/screenshots/34-m11-mobile-dark.png', fullPage: true });
});

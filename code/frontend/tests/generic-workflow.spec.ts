import { test, expect, type Page } from '@playwright/test';

test('run waits until the selected published version has loaded', async ({ page }) => {
  let unblock!: () => void;
  let requested!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const received = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/api/agents/customer-order-summary/versions', async (route) => {
    const response = await route.fetch();
    requested();
    await blocked;
    await route.fulfill({ response });
  });
  await page.goto('/?workflow=customer-order-summary');
  await received;
  const run = page.getByRole('button', { name: '运行', exact: true });
  try {
    await expect(run).toBeDisabled();
    await expect(page.getByRole('button', { name: '运行工作流', exact: true })).toBeDisabled();
  } finally {
    unblock();
  }
  await expect(run).toBeEnabled();
});

async function addMapping(page: Page, name: string, source: string, path = '') {
  await page.getByTitle('添加输入参数').click();
  const field = page.locator('.mapping-key').last();
  await field.fill(name);
  await page.getByLabel('节点名称', { exact: true }).click();
  await page.getByLabel(`${name} 来源`, { exact: true }).selectOption(source);
  await page.getByLabel(`${name} 引用路径`, { exact: true }).fill(path);
}

async function addNode(page: Page, label: string, type: string) {
  await page.getByTitle('添加节点').click();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: label }).click();
  const node = page.locator(`.workflow-node.type-${type}`).last();
  await expect(node).toBeVisible();
  return (await node.getAttribute('data-node-id'))!;
}

async function applyNode(page: Page) {
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('节点配置已应用');
  await page.getByTitle('关闭节点配置').click();
}

async function connect(page: Page, from: string, to: string) {
  const source = await page.locator(`[data-port-entity-id="port_output_${from}_"]`).boundingBox();
  const target = await page.locator(`[data-port-entity-id="port_input_${to}_"]`).boundingBox();
  if (!source || !target) throw new Error('Missing ports');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator(`[data-line-id="${from}_-${to}_"]`)).toHaveCount(1);
}

test('six-node V2 workflow edits, publishes, pauses, reloads and resumes once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?workflow=customer-order-summary');
  await expect(page.locator('.workflow-node')).toHaveCount(6);
  await expect(page.getByLabel('客户编号')).toHaveValue('CUST-1001');
  await page.locator('.workflow-node[data-node-id="n_summary"]').click();
  await expect(page.getByLabel('模型档案版本')).toContainText('工作空间默认模型');
  await page
    .getByLabel('系统提示词')
    .fill('仅根据输入的订单数据生成简明摘要，不补充事实，返回 JSON。');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTitle('关闭节点配置').click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toContainText('CUST-1001', { timeout: 20000 });
  await expect(page.locator('.human-confirmation')).toContainText('3 笔订单');
  await expect(page.locator('.result-overview')).toContainText('等待人工确认');
  await page.screenshot({
    path: '../docs/screenshots/19-order-summary-confirmation.png',
    fullPage: true,
  });
  const runId = new URL(page.url()).searchParams.get('run')!;
  const before = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(before.usage.model_calls).toBe(1);
  expect(before.usage.tool_calls).toBe(1);
  await page.reload();
  await expect(page.locator('.human-confirmation')).toBeVisible();
  await page.getByLabel('反馈').fill('已核对订单，确认摘要');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  await expect(page.locator('.analysis-result')).toContainText('CUST-1001');
  await expect(page.locator('.verification-line')).toContainText('业务规则核验通过');
  const after = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(after.result.approved).toBe(true);
  expect(after.usage).toEqual(before.usage);
  expect(Object.keys(after.node_results)).toHaveLength(6);
  await page.screenshot({
    path: '../docs/screenshots/20-order-summary-completed.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: /运行事件/ }).click();
  await expect(page.locator('.event-list')).toContainText('人工确认已处理');
  expect(errors).toEqual([]);
});

test('V2 six-node workflow can be assembled from blank without backend edits', async ({ page }) => {
  await page.goto('/');
  await page.getByTitle('新建工作流菜单', { exact: true }).click();
  await page.getByRole('button', { name: '新建工作流', exact: true }).click();
  await page.getByLabel('工作流名称', { exact: true }).fill(`通用流程-${Date.now()}`);
  await expect(page.getByLabel('流程类型')).toHaveValue('2.0');
  await page.getByRole('button', { name: '创建工作流', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);
  await page.locator('.workflow-node[data-node-id="n_input"]').click();
  await page.getByTitle('添加入口字段').click();
  await page.getByLabel('field_1 字段名', { exact: true }).fill('customer_id');
  await page.getByLabel('field_1 显示名称', { exact: true }).click();
  await page.getByLabel('customer_id 显示名称', { exact: true }).fill('客户编号');
  await page.getByLabel('必填', { exact: true }).check();
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  await page.getByTitle('添加节点').click();
  await expect(page.getByRole('dialog')).toContainText('HTTP 查询');
  await page.getByRole('dialog').getByRole('button').filter({ hasText: 'HTTP 查询' }).click();
  await expect(page.getByLabel('HTTP 连接版本')).toContainText('本地订单示例服务');
  await expect(page.getByLabel('HTTP 操作')).toContainText('查询客户订单');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  const query = (await page.locator('.workflow-node.type-http').getAttribute('data-node-id'))!;
  await page.getByTitle('关闭节点配置').click();
  const summary = await addNode(page, '模型生成', 'llm');
  await page.getByLabel('data 来源').selectOption(query);
  await page.getByLabel('data 引用路径').fill('data');
  await applyNode(page);
  const verify = await addNode(page, '业务核验', 'verify');
  await page.getByLabel('核验规则').selectOption('order-summary@1');
  await page.getByLabel('value 参数名', { exact: true }).fill('response');
  await page.getByLabel('节点名称', { exact: true }).click();
  await page.getByLabel('response 来源').selectOption(query);
  await addMapping(page, 'customer_id', 'input', 'customer_id');
  await addMapping(page, 'analysis', summary);
  await applyNode(page);
  const review = await addNode(page, '人工确认', 'human_input');
  await page.getByLabel('summary 来源').selectOption(summary);
  await page.getByLabel('summary 引用路径').fill('summary');
  await applyNode(page);
  await page.locator('.workflow-node[data-node-id="n_output"]').click();
  await page.locator('.schema-designer details summary').click();
  await page.getByLabel('结果字段 Schema').fill(
    JSON.stringify({
      type: 'object',
      properties: { summary: { type: 'string' }, approved: { type: 'boolean' } },
      required: ['summary', 'approved'],
      additionalProperties: false,
    }),
  );
  await page.getByLabel('节点名称', { exact: true }).click();
  await addMapping(page, 'summary', summary, 'summary');
  await addMapping(page, 'approved', review, 'accepted');
  await applyNode(page);
  await page.getByTitle('自动布局').click();
  await expect(page.locator('.workflow-node')).toHaveCount(6);
  await connect(page, 'n_input', query);
  await connect(page, query, summary);
  await connect(page, summary, verify);
  await connect(page, verify, review);
  await connect(page, review, 'n_output');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toContainText('3 笔订单', { timeout: 20000 });
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功');
});

test('model profile UI creates, tests and exposes a selectable version', async ({ page }) => {
  await page.goto('/?settings=models');
  await page.getByRole('button', { name: '模型档案', exact: true }).click();
  await page.getByRole('button', { name: '新建模型档案', exact: true }).click();
  const name = `离线测试档案-${Date.now()}`;
  await page.getByLabel('资源名称').fill(name);
  await page.getByLabel('档案模式').selectOption('demo');
  await page.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(page.locator('.resource-list')).toContainText(name);
  await page.getByTitle(`测试 ${name}`).click();
  await expect(page.locator('.resource-feedback')).toContainText('离线演示模型可用');
  await page.getByRole('button', { name: 'HTTP 连接', exact: true }).click();
  await expect(page.locator('.resource-list')).toContainText('本地订单示例服务');
});

test('mobile confirmation stays within viewport and reject cancels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?workflow=customer-order-summary');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  const bounds = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport);
  await page.screenshot({
    path: '../docs/screenshots/21-order-summary-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '拒绝并取消', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('已取消', { timeout: 10000 });
});

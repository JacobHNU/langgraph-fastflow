import { test, expect } from './fixtures';

test('HTTP tools can be created on the canvas, trialled, published and executed', async ({
  page,
}) => {
  const source = await (await page.request.get('/api/agents/customer-order-summary')).json();
  const response = await page.request.post('/api/agents', {
    data: { name: '软件工具编辑示例', workflow: source.workflow, layout: source.layout },
  });
  const agent = await response.json();
  await page.goto(`/?workflow=${agent.id}`);
  await page.locator('.workflow-node[data-node-id="n_orders"]').click();
  await page.getByText('添加 / 编辑软件工具', { exact: true }).click();
  await page.getByRole('button', { name: '新建连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 HTTP 连接', exact: true });
  await dialog.getByLabel('资源名称').fill(`画布软件查询 ${agent.id}`);
  await dialog
    .getByLabel('资源服务地址')
    .fill(process.env.E2E_ORDERS_URL || 'http://127.0.0.1:18769');
  await dialog.getByLabel('连接认证方式').selectOption('none');
  await dialog.getByLabel('操作 ID', { exact: true }).fill('software.editor-query@1');
  await dialog.getByLabel('GET 路径').fill('/customers/{id}/orders');
  await dialog.getByRole('button', { name: '保存版本' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('id 来源', { exact: true }).selectOption('constant');
  await page.getByLabel('id 常量值', { exact: true }).fill('CUST-1001');
  await page.getByLabel('节点名称', { exact: true }).click();
  await page.getByText('添加 / 编辑软件工具', { exact: true }).click();
  await page.getByText('节点试跑', { exact: true }).click();
  await page.getByLabel('表单填写调试输入').check();
  await page.getByLabel('调试输入 JSON', { exact: true }).fill('{"id":"CUST-1001"}');
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('ORD-1001', { timeout: 15000 });
  expect((await (await page.request.get(`/api/agents/${agent.id}`)).json()).revision).toBe(1);
  await page.screenshot({ path: '../docs/screenshots/46-http-tool-editor.png', fullPage: true });
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('节点配置已应用');
  await page.getByTitle('关闭节点配置').click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 15000 });
});

test('software Skill is created inline, explicitly selected and pinned during trial and save', async ({
  page,
}) => {
  const source = await (await page.request.get('/api/agents/customer-order-summary')).json();
  const node = source.workflow.nodes.find((n: any) => n.id === 'n_summary');
  node.type = 'agent';
  node.config.executor = 'langchain_agent';
  node.config.skills = [];
  node.config.tools = [];
  const response = await page.request.post('/api/agents', {
    data: { name: '软件 Skill 编排示例', workflow: source.workflow, layout: source.layout },
  });
  const agent = await response.json();
  await page.goto(`/?workflow=${agent.id}`);
  await page.locator('.workflow-node[data-node-id="n_summary"]').click();
  await page.getByText('添加 / 编辑软件工具与 Skill', { exact: true }).click();
  await page.getByRole('button', { name: '新建 Skill', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑 Skill', exact: true });
  const name = `订单查询 Skill ${agent.id}`;
  await dialog.getByLabel('Skill 名称', { exact: true }).fill(name);
  await dialog
    .getByLabel('Skill 操作说明')
    .fill('# 软件订单查询\n调用 orders.list@1 获取客户订单。根据真实结果生成摘要，标明缺失信息。');
  await dialog
    .getByLabel(`绑定 ${source.workflow.dependency_refs.connections[0]} orders.list@1`, {
      exact: true,
    })
    .check();
  await dialog.getByRole('button', { name: '保存 Skill 版本', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const skills = await (await page.request.get('/api/skills')).json();
  const skill = skills.find((s: any) => s.name === name);
  await page.getByText('添加 / 编辑软件工具与 Skill', { exact: true }).click();
  await page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true }).check();
  await page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../docs/screenshots/47-skill-node-editor.png', fullPage: true });
  expect(
    (await (await page.request.get(`/api/agents/${agent.id}`)).json()).workflow.nodes.find(
      (n: any) => n.id === 'n_summary',
    ).config.skills,
  ).toEqual([]);
  await page.getByText('节点试跑', { exact: true }).click();
  await page
    .getByLabel('调试输入 JSON', { exact: true })
    .fill(JSON.stringify({ customer_id: 'CUST-1001', orders: [] }));
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('CUST-1001', { timeout: 15000 });
  await page.getByText(/调试事件与模型日志（/).click();
  await expect(page.locator('.node-debug')).toContainText('skill.loaded');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('节点配置已应用');
  await page.getByTitle('关闭节点配置').click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  const saved = await (await page.request.get(`/api/agents/${agent.id}`)).json();
  expect(saved.workflow.dependency_refs.skills).toEqual([skill.ref]);
  expect(saved.workflow.nodes.find((n: any) => n.id === 'n_summary').config.tools).toContain(
    'orders.list@1',
  );
  await page.reload();
  await page.locator('.workflow-node[data-node-id="n_summary"]').click();
  await expect(page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../docs/screenshots/48-skill-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByTitle('关闭节点配置').click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 15000 });
});

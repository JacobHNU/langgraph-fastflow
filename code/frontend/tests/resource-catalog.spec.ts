import { test, expect, type Page } from './fixtures';

async function fixture(page: Page) {
  const source = await (await page.request.get('/api/agents/customer-order-summary')).json();
  const original = (await (await page.request.get('/api/connections')).json()).find(
    (c: any) => c.id === 'conn_orders',
  );
  const key = Date.now().toString(36);
  const operation = {
    ...original.operations[0],
    id: `catalog.query-${key}@1`,
    name: `查订单 ${key}`,
  };
  const body = {
    name: `目录查询 ${key}`,
    base_url: process.env.E2E_ORDERS_URL || 'http://127.0.0.1:18770',
    auth_type: 'none',
    operations: [operation],
  };
  const connection = await (await page.request.post('/api/connections', { data: body })).json();
  const nextConnection = await (
    await page.request.put(`/api/connections/${connection.id}`, {
      data: {
        ...body,
        revision: 1,
        operations: [{ ...operation, path: '/v2/customers/{customer_id}/orders' }],
      },
    })
  ).json();
  const skillBody = {
    name: `目录 Skill ${key}`,
    description: `客户订单摘要 ${key}`,
    content: '# CATALOG_SKILL_ONE\n请依据软件查询结果输出摘要。',
    tools: [operation.id],
    connection_refs: [connection.ref],
    input_schema: source.workflow.input_schema,
  };
  const skill = await (await page.request.post('/api/skills', { data: skillBody })).json();
  const workflow = structuredClone(source.workflow);
  const http = workflow.nodes.find((n: any) => n.type === 'http');
  http.config = { connection_ref: connection.ref, operation_ref: operation.id };
  const node = workflow.nodes.find((n: any) => n.id === 'n_summary');
  node.type = 'agent';
  node.config = {
    ...node.config,
    executor: 'langchain_agent',
    skills: [skill.ref],
    tools: [operation.id],
  };
  workflow.dependency_refs.connections = [connection.ref];
  workflow.dependency_refs.tools = [operation.id];
  workflow.dependency_refs.skills = [skill.ref];
  workflow.policy.capability_refs = [operation.id];
  workflow.policy.resource_scopes = ['http:registered'];
  const created = await page.request.post('/api/agents', {
    data: { name: `资源版本编排 ${key}`, workflow, layout: source.layout },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const agent = await created.json();
  const preview = await (await page.request.post(`/api/agents/${agent.id}/simulate`)).json();
  expect(preview.valid, JSON.stringify(preview)).toBe(true);
  const releaseResponse = await page.request.post(`/api/agents/${agent.id}/publish`, {
    data: { revision: agent.revision, confirmed: true },
  });
  expect(releaseResponse.ok(), await releaseResponse.text()).toBeTruthy();
  const oldReleases = await (await page.request.get(`/api/agents/${agent.id}/versions`)).json();
  const nextSkill = await (
    await page.request.put(`/api/skills/${skill.id}`, {
      data: {
        ...skillBody,
        revision: 1,
        content: '# CATALOG_SKILL_TWO\n请依据软件查询结果输出摘要并说明来源。',
      },
    })
  ).json();
  return { key, agent, connection, nextConnection, skill, nextSkill, oldReleases, operation };
}

test('HTTP catalog searches paths, previews old versions and adopts only on confirmation', async ({
  page,
}) => {
  const { agent, connection, nextConnection, key } = await fixture(page);
  await page.goto(`/?workflow=${agent.id}`);
  await page.locator('[data-node-id="n_orders"].workflow-node').click();
  await page.getByRole('button', { name: '搜索与预览 HTTP 工具版本' }).click();
  const dialog = page.getByRole('dialog', { name: 'HTTP 工具资源目录' });
  await dialog.getByLabel('搜索资源目录').fill(`/v2/customers/ ${key}`);
  await expect(dialog.locator('.resource-browser-list button')).toHaveCount(1);
  await expect(dialog.getByLabel('预览资源版本')).toHaveValue(connection.ref);
  await dialog.getByLabel('预览资源版本').selectOption(nextConnection.ref);
  await expect(dialog.locator('.resource-browser-detail')).toContainText('/v2/customers/');
  await expect(dialog.locator('.resource-version-notice')).toContainText(
    '历史发布和运行保留原版本',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('HTTP 连接版本', { exact: true })).toHaveValue(connection.ref);
  await page.getByRole('button', { name: '搜索与预览 HTTP 工具版本' }).click();
  await dialog.getByLabel('预览资源版本').selectOption(nextConnection.ref);
  await dialog.getByLabel('预览资源版本').selectOption(connection.ref);
  await page.screenshot({
    path: '../docs/screenshots/49-http-resource-catalog.png',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '采用此连接与操作版本' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByText('节点试跑', { exact: true }).click();
  await page.getByLabel('调试输入 JSON', { exact: true }).fill('{"customer_id":"CUST-1001"}');
  await page.getByRole('button', { name: '试跑节点', exact: true }).click();
  await expect(page.getByTestId('debug-output')).toContainText('ORD-1001', { timeout: 15000 });
  expect(
    (await (await page.request.get(`/api/agents/${agent.id}`)).json()).workflow.nodes.find(
      (n: any) => n.id === 'n_orders',
    ).config.connection_ref,
  ).toBe(connection.ref);
});

test('Skill version preview preserves draft and release; explicit adoption saves and executes new version', async ({
  page,
}) => {
  const { agent, skill, nextSkill, oldReleases, key } = await fixture(page);
  await page.goto(`/?workflow=${agent.id}`);
  await page.locator('[data-node-id="n_summary"].workflow-node').click();
  await page.getByRole('button', { name: '搜索与预览 Skill 版本' }).click();
  const dialog = page.getByRole('dialog', { name: 'Skill资源目录' });
  await dialog.getByLabel('搜索资源目录').fill(key);
  await expect(dialog.locator('.resource-browser-list button')).toHaveCount(1);
  await expect(dialog.getByTestId('resource-skill-content')).toContainText('CATALOG_SKILL_ONE');
  await dialog.getByLabel('预览资源版本').selectOption(nextSkill.ref);
  await expect(dialog.getByTestId('resource-skill-content')).toContainText('CATALOG_SKILL_TWO');
  await expect(page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true })).toBeChecked();
  await expect(page.getByLabel(`选择 Skill ${nextSkill.ref}`, { exact: true })).not.toBeChecked();
  await page.screenshot({
    path: '../docs/screenshots/50-skill-version-preview.png',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '授权并采用此 Skill 版本' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true })).not.toBeChecked();
  await expect(page.getByLabel(`选择 Skill ${nextSkill.ref}`, { exact: true })).toBeChecked();
  expect(
    (await (await page.request.get(`/api/agents/${agent.id}`)).json()).workflow.dependency_refs
      .skills,
  ).toEqual([skill.ref]);
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('节点配置已应用');
  await page.getByTitle('关闭节点配置').click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await (await page.request.get(`/api/agents/${agent.id}`)).json();
  expect(saved.workflow.dependency_refs.skills).toEqual([nextSkill.ref]);
  const releases = await (await page.request.get(`/api/agents/${agent.id}/versions`)).json();
  expect(releases.find((r: any) => r.version === oldReleases[0].version)).toEqual(oldReleases[0]);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 15000 });
  const runId = new URL(page.url()).searchParams.get('run');
  const events = await (await page.request.get(`/api/runs/${runId}/event-log`)).json();
  expect(events.find((e: any) => e.event_type === 'skill.loaded').payload.skills[0].ref).toBe(
    nextSkill.ref,
  );
});

test('catalog ignores late history responses after selecting another resource and handles errors', async ({
  page,
}) => {
  const { agent, skill, connection } = await fixture(page);
  const otherResponse = await page.request.post('/api/skills', {
    data: {
      name: `另一 Skill ${agent.id}`,
      content: '# OTHER_SKILL',
      tools: [],
      connection_refs: [],
      input_schema: { type: 'object', properties: {} },
    },
  });
  const other = await otherResponse.json();
  await page.goto(`/?workflow=${agent.id}`);
  await page.locator('[data-node-id="n_summary"].workflow-node').click();
  await expect(page.getByLabel(`选择 Skill ${skill.ref}`, { exact: true })).toBeChecked();
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  await page.route(`**/skills/${skill.id}/versions`, async (route) => {
    const response = await route.fetch();
    await slow;
    await route.fulfill({ response });
  });
  const lateResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/skills/${skill.id}/versions`),
  );
  await page.getByRole('button', { name: '搜索与预览 Skill 版本' }).click();
  const dialog = page.getByRole('dialog', { name: 'Skill资源目录' });
  try {
    await dialog.locator('.resource-browser-list button').filter({ hasText: other.id }).click();
    await expect(dialog.getByTestId('resource-skill-content')).toContainText('OTHER_SKILL');
  } finally {
    releaseSlow();
  }
  await lateResponse;
  await expect(dialog.getByLabel('预览资源版本')).toHaveValue(other.ref);
  await expect(dialog.getByTestId('resource-skill-content')).toContainText('OTHER_SKILL');
  await dialog.getByLabel('搜索资源目录').fill('no-match-unique-resource');
  await expect(dialog).toContainText('没有匹配的资源');
  await page.keyboard.press('Escape');
  await page.unroute(`**/skills/${skill.id}/versions`);
  await page.route(`**/skills/${skill.id}/versions`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: (await response.json()).filter((s: any) => s.ref !== skill.ref),
    });
  });
  await page.getByRole('button', { name: '搜索与预览 Skill 版本' }).click();
  await expect(dialog.getByRole('alert')).toContainText('不存在，请明确选择其他版本');
  await expect(dialog.getByRole('button', { name: '授权并采用此 Skill 版本' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByTitle('关闭节点配置').click();
  await page.locator('[data-node-id="n_orders"].workflow-node').click();
  await page.route(`**/connections/${connection.id}/versions`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"detail":"目录暂时不可用"}',
    }),
  );
  await page.getByRole('button', { name: '搜索与预览 HTTP 工具版本' }).click();
  const httpDialog = page.getByRole('dialog', { name: 'HTTP 工具资源目录' });
  await expect(httpDialog.getByRole('alert')).toContainText('目录暂时不可用');
  await expect(httpDialog.getByRole('button', { name: '采用此连接与操作版本' })).toBeDisabled();
});

test('Skill editor selects historical tools and catalog remains usable on mobile in dark theme', async ({
  page,
}) => {
  const { key, connection, skill } = await fixture(page);
  await page.request.put('/api/me/preferences', {
    data: { theme: 'dark', accent: 'teal', default_workspace_id: 'ws_legacy' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('搜索 Skill', { exact: true }).fill(key);
  await expect(page.locator('.resource-manager .resource-row')).toHaveCount(1);
  await page.getByRole('button', { name: '查看 Skill 历史版本' }).click();
  const skillDialog = page.getByRole('dialog', { name: 'Skill资源目录' });
  await skillDialog.getByLabel('预览资源版本').selectOption(skill.ref);
  await expect(skillDialog.getByTestId('resource-skill-content')).toContainText(
    'CATALOG_SKILL_ONE',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '../docs/screenshots/51-resource-catalog-mobile.png',
    fullPage: true,
  });
  await skillDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Skill', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑 Skill', exact: true });
  await edit.getByRole('button', { name: '从目录选择工具历史版本' }).click();
  const toolDialog = page.getByRole('dialog', { name: 'HTTP 工具资源目录' });
  await toolDialog.getByLabel('预览资源版本').selectOption(connection.ref);
  await toolDialog.getByRole('button', { name: '采用此连接与操作版本' }).click();
  await edit.getByRole('button', { name: '保存 Skill 版本', exact: true }).click();
  await expect(edit).toHaveCount(0);
  const versions = await (await page.request.get(`/api/skills/${skill.id}/versions`)).json();
  const saved = versions.find((v: any) => v.revision === 3);
  expect(saved.connection_refs).toEqual([connection.ref]);
});

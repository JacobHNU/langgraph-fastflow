import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures';

test('provider switching preserves scoped credentials and unsaved probes cannot change settings', async ({
  page,
}) => {
  const calls: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the request */
    }
    calls.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'w0-probe',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    await page.goto('/?settings=models');
    await page.getByLabel('运行模式').selectOption('openai');
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('Base URL', { exact: true }).fill(endpoint);
    await page.getByLabel('模型名称', { exact: true }).fill('fixture');
    await page.getByLabel('API Key', { exact: true }).fill('w0-browser-key');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('已配置');
    // Save a different provider with no key, then return to the original one.
    await page.getByLabel('服务商', { exact: true }).selectOption('deepseek');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.model-feedback')).toContainText('填写 API Key');
    expect(calls).toEqual([]);
    const unchanged = await (await page.request.get('/api/settings/model')).json();
    expect(unchanged.base_url).toBe(endpoint);
    expect(unchanged.api_key_configured).toBe(true);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('未配置');
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('Base URL', { exact: true }).fill(endpoint);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.model-feedback')).toContainText('模型连接成功');
    expect(calls).toEqual(['Bearer w0-browser-key']);
    expect((await (await page.request.get('/api/settings/model')).json()).provider).toBe(
      'deepseek',
    );
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('已配置');
    await page.getByTitle('清除密钥', { exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('待清除当前服务密钥');
    await page.getByRole('button', { name: '保留已存密钥', exact: true }).click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('已配置');
    await page.screenshot({
      path: '../docs/screenshots/43-w0-scoped-model-settings.png',
      fullPage: true,
    });
    await page.getByTitle('清除密钥', { exact: true }).click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('未配置');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('cancelled human task closes on screen and records its closure event', async ({ page }) => {
  await page.goto('/?workflow=customer-order-summary');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  const runId = new URL(page.url()).searchParams.get('run')!;
  await page.getByRole('button', { name: '请求取消', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('已取消');
  await expect(page.locator('.human-confirmation')).toHaveCount(0);
  await expect(page.locator('.approval-banner')).toContainText('已关闭');
  await page.reload();
  await expect(page.locator('.approval-banner')).toContainText('RUN_CANCELLED');
  const run = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(run.input_requests[0].status).toBe('CANCELLED');
  await page.getByRole('button', { name: /运行事件/ }).click();
  await expect(page.locator('.event-list')).toContainText('人工确认已关闭');
  await page.locator('.event-row').filter({ hasText: '人工确认已关闭' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '../docs/screenshots/44-w0-human-task-closed.png',
    fullPage: true,
  });
});

test('mobile sensitive business feedback reaches the result with its original meaning', async ({
  page,
}) => {
  const workflow = (await (await page.request.get('/api/agents/customer-order-summary')).json())
    .workflow;
  const human = workflow.nodes.find((n: any) => n.type === 'human_input');
  const form = {
    type: 'object',
    properties: {
      authorization_status: { type: 'string', title: '业务授权状态' },
      secretary_note: { type: 'string', title: '业务联系人说明' },
    },
    required: ['authorization_status', 'secretary_note'],
    additionalProperties: false,
  };
  human.config.form_schema = form;
  human.output_schema = {
    ...form,
    properties: { ...form.properties, accepted: { type: 'boolean' } },
  };
  workflow.nodes.find((n: any) => n.type === 'output').inputs.feedback = {
    source: 'node',
    node_id: human.id,
    path: [],
  };
  workflow.output_schema.properties.feedback = { type: 'object' };
  const created = await page.request.post('/api/agents', {
    data: { name: 'W0 业务反馈示例', workflow },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const agent = await created.json();
  const simulation = await page.request.post(`/api/agents/${agent.id}/simulate`);
  expect((await simulation.json()).valid).toBe(true);
  const published = await page.request.post(`/api/agents/${agent.id}/publish`, {
    data: { revision: agent.revision, confirmed: true },
  });
  expect(published.ok(), await published.text()).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?workflow=${agent.id}`);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toBeVisible({ timeout: 20000 });
  await page.getByLabel(/^业务授权状态/).fill('业务已授权');
  await page.getByLabel(/^业务联系人说明/).fill('业务联系人已核对');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  const runId = new URL(page.url()).searchParams.get('run')!;
  const run = await (await page.request.get(`/api/runs/${runId}`)).json();
  expect(run.result.feedback).toEqual({
    authorization_status: '业务已授权',
    secretary_note: '业务联系人已核对',
    accepted: true,
  });
  await page.getByText('完整结构化结果', { exact: true }).click();
  await expect(page.locator('.result-data')).toContainText('业务联系人已核对');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '../docs/screenshots/45-w0-business-feedback-mobile.png',
    fullPage: true,
  });
});

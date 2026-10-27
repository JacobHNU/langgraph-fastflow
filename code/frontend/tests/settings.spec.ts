import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('model settings persist securely and drive real workflow model requests', async ({ page }) => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'ui-test-model' }, { id: 'another-model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ body, authorization: req.headers.authorization });
    if (req.headers.authorization === 'Bearer rejected-ui-key') {
      res.writeHead(401);
      res.end(
        JSON.stringify({ error: { message: 'rejected-ui-key', type: 'authentication_error' } }),
      );
      return;
    }
    const assessment = body.messages.some((m: any) =>
      String(m.content).includes('EVALUATION_BUNDLE'),
    );
    res.end(
      JSON.stringify({
        id: 'ui-test-completion',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: 'Configured model responded',
                risk_level: 'low',
                recommendations: ['Check delivery'],
                ...(assessment ? { assessment: 'SUPPORTED' } : {}),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const original = await (await page.request.get('/api/settings/model')).json();
  try {
    await page.goto('/?settings=models');
    await expect(page.getByRole('heading', { name: '大模型连接' })).toBeVisible();
    await page.getByLabel('运行模式').selectOption('openai');
    await page.getByLabel('服务商', { exact: true }).selectOption('custom');
    await page.getByLabel('Base URL', { exact: true }).fill(baseURL);
    await page.getByLabel('模型名称', { exact: true }).fill('ui-test-model');
    await page.getByLabel('API Key', { exact: true }).fill('private-ui-key');
    await page.getByLabel('请求超时（秒）').fill('12');
    await page.getByLabel('最大输出 Token').fill('512');
    await page.getByLabel('Temperature', { exact: true }).fill('0.4');
    await page.getByTitle('获取模型列表').click();
    await expect(page.getByRole('status')).toContainText('已读取 2 个模型');
    await expect(page.locator('#available-models option')).toHaveCount(2);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('模型连接成功');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').last()).toContainText('模型配置已保存');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.locator('.key-status')).toHaveText('已配置');
    const saved = await (await page.request.get('/api/settings/model')).json();
    expect(saved.api_key).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('private-ui-key');
    await page.reload();
    await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('ui-test-model');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('最大输出 Token')).toHaveValue('512');
    await page.screenshot({ path: '../docs/screenshots/09-model-settings.png', fullPage: true });
    await page.getByRole('button', { name: '工作流', exact: true }).click();
    await page.locator('.agent-link').filter({ hasText: '模型结构化摘要' }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
      timeout: 20000,
    });
    await expect(page.locator('.analysis-result')).toContainText('Configured model responded');
    expect(
      calls.some(
        (c) =>
          c.body.model === 'ui-test-model' &&
          c.body.temperature === 0.4 &&
          (c.body.max_completion_tokens ?? c.body.max_tokens) === 512,
      ),
    ).toBeTruthy();
    expect(calls.every((c) => c.authorization === 'Bearer private-ui-key')).toBeTruthy();
    await page.getByTitle('工作空间设置').click();
    await page.getByLabel('API Key', { exact: true }).fill('rejected-ui-key');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.model-feedback [role="status"]')).toContainText('认证失败');
    await expect(page.locator('.model-feedback')).not.toContainText('rejected-ui-key');
    await page.getByTitle('清除密钥').click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.locator('.key-status')).toHaveText('未配置');
  } finally {
    const { api_key_configured: _key, source: _source, updated_at: _updated, ...values } = original;
    await page.request.put('/api/settings/model', {
      data: { ...values, api_key: null, clear_api_key: true },
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('model configuration is usable on mobile and tests the offline mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?settings=models');
  await expect(page.getByLabel('运行模式')).toBeVisible();
  await page.getByLabel('运行模式').selectOption('demo');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('离线演示模型可用');
  const widths = await page.evaluate(() => ({
    content: document.body.scrollWidth,
    viewport: innerWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
  await page.screenshot({
    path: '../docs/screenshots/10-model-settings-mobile.png',
    fullPage: true,
  });
});

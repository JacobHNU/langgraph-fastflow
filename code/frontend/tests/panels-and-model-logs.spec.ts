import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

async function drag(page: Page, name: string, dx: number, dy: number) {
  const handle = page.getByRole('separator', { name });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Missing separator: ${name}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

test('panel separators resize, persist, reset and respect responsive limits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  const before = await page.locator('.sidebar').boundingBox();
  const right = await page.locator('.right-panel').boundingBox();
  const monitor = await page.locator('.run-monitor').boundingBox();
  await drag(page, '调整左侧列表宽度', 60, 0);
  await drag(page, '调整右侧配置宽度', -80, 0);
  await drag(page, '调整执行结果高度', 0, -100);
  const expectedSidebar = before!.width + 60;
  const expectedRight = right!.width + 80;
  const expectedMonitor = monitor!.height + 100;
  await expect
    .poll(async () => (await page.locator('.sidebar').boundingBox())!.width)
    .toBeCloseTo(expectedSidebar, 0);
  await expect
    .poll(async () => (await page.locator('.right-panel').boundingBox())!.width)
    .toBeCloseTo(expectedRight, 0);
  await expect
    .poll(async () => (await page.locator('.run-monitor').boundingBox())!.height)
    .toBeCloseTo(expectedMonitor, 0);
  await expect(page.locator('.workflow-node').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await expect
    .poll(async () => (await page.locator('.sidebar').boundingBox())!.width)
    .toBeCloseTo(expectedSidebar, 0);
  await expect
    .poll(async () => (await page.locator('.right-panel').boundingBox())!.width)
    .toBeCloseTo(expectedRight, 0);
  await expect
    .poll(async () => (await page.locator('.run-monitor').boundingBox())!.height)
    .toBeCloseTo(expectedMonitor, 0);
  await page.getByRole('separator', { name: '调整右侧配置宽度' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await page.locator('.right-panel').boundingBox())!.width)
    .toBeCloseTo(expectedRight + 10, 0);
  await page.getByRole('separator', { name: '调整右侧配置宽度' }).dblclick();
  await expect
    .poll(async () => (await page.locator('.right-panel').boundingBox())!.width)
    .toBeCloseTo(right!.width, 0);
  await drag(page, '调整执行结果高度', 0, -1500);
  expect((await page.locator('.canvas-area').boundingBox())!.height).toBeGreaterThanOrEqual(239);
  await drag(page, '调整执行结果高度', 0, 1500);
  await expect
    .poll(async () => (await page.locator('.run-monitor').boundingBox())!.height)
    .toBe(160);
  await page.setViewportSize({ width: 1100, height: 800 });
  await drag(page, '调整右侧配置宽度', -1000, 0);
  expect((await page.locator('.canvas-and-monitor').boundingBox())!.width).toBeGreaterThanOrEqual(
    399,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test('multi-round Agent logs show model inputs, tool requests, responses and replayed events', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.agent-link').filter({ hasText: '业务材料分析' }).click();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
    timeout: 30000,
  });
  const log = page.getByRole('region', { name: '模型调用日志' });
  await expect(log.locator('.model-call')).toHaveCount(2);
  await expect(log).toContainText('调用完成');
  await expect(log).toContainText('query_project');
  await expect(log).toContainText('Token');
  await log.locator('.model-input > summary').first().click();
  await expect(log.locator('.model-input').first()).toContainText('PRJ-1001');
  await log.locator('.model-input > summary').first().click();
  await drag(page, '调整执行结果高度', 0, -180);
  await log.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../docs/screenshots/11-agent-model-logs.png', fullPage: true });
  const url = page.url();
  await page.getByRole('button', { name: /运行事件/ }).click();
  const calls = page
    .locator('.event-row')
    .filter({ has: page.locator('strong', { hasText: '模型调用' }) });
  await expect(calls).toHaveCount(2);
  await calls.first().getByTitle('查看事件详情').click();
  await expect(calls.first().locator('.model-event-details')).toContainText('PRJ-1001');
  const responses = page
    .locator('.event-row')
    .filter({ has: page.locator('strong', { hasText: '模型响应' }) });
  await expect(responses).toHaveCount(2);
  await responses.first().getByTitle('查看事件详情').click();
  await expect(responses.first().locator('.model-event-details')).toContainText('query_project');
  await page.goto(url);
  await expect(
    page.getByRole('region', { name: '模型调用日志' }).locator('.model-call'),
  ).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
});

test('live model calls show pending, full long responses and failed events', async ({ page }) => {
  let release = () => {};
  let fail = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const evaluation = body.messages.some((m: any) =>
      String(m.content).includes('EVALUATION_BUNDLE'),
    );
    if (!evaluation)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    res.setHeader('Content-Type', 'application/json');
    if (fail && !evaluation) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error: { message: 'Provider rejected request', type: 'authentication_error' },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: 'chatcmpl-logs',
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
                summary: evaluation
                  ? 'Evaluation'
                  : 'Long response ' + 'result '.repeat(450) + 'FULL_RESPONSE_END',
                risk_level: 'low',
                recommendations: [],
                ...(evaluation ? { assessment: 'SUPPORTED' } : {}),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 500, total_tokens: 510 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const original = await (await page.request.get('/api/settings/model')).json();
  try {
    const { api_key_configured: _key, source: _source, updated_at: _updated, ...values } = original;
    await page.request.put('/api/settings/model', {
      data: {
        ...values,
        mode: 'openai',
        provider: 'custom',
        model: 'log-test-model',
        base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        requires_api_key: false,
        clear_api_key: true,
        timeout_seconds: 20,
      },
    });
    await page.goto('/');
    await page.locator('.agent-link').filter({ hasText: '模型结构化摘要' }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    const log = page.getByRole('region', { name: '模型调用日志' });
    await expect(log).toContainText('调用中');
    await expect(log).toContainText('log-test-model');
    release();
    await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
      timeout: 15000,
    });
    await expect(log).toContainText('510 Token');
    const output = log.locator('.model-output');
    await output.getByRole('button', { name: '加载完整调用记录' }).click();
    await expect(output).toContainText('FULL_RESPONSE_END');
    await expect(output.getByRole('button', { name: '加载完整调用记录' })).toHaveCount(0);
    fail = true;
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(log).toContainText('调用中');
    release();
    await expect(log).toContainText('调用失败', { timeout: 15000 });
    await expect(log).toContainText('AuthenticationError');
    await page.getByRole('button', { name: /运行事件/ }).click();
    const failed = page
      .locator('.event-row')
      .filter({ has: page.locator('strong', { hasText: '模型调用失败' }) });
    await expect(failed).toHaveCount(1);
    await failed.getByTitle('查看事件详情').click();
    await expect(failed).toContainText('MODEL_CALL_FAILED');
  } finally {
    release();
    const { api_key_configured: _key, source: _source, updated_at: _updated, ...values } = original;
    await page.request.put('/api/settings/model', {
      data: { ...values, api_key: null, clear_api_key: true },
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

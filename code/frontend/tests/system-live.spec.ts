import { test, expect } from '@playwright/test';
import { TEST_PASSWORD, TEST_USERNAME } from './fixtures';

test('initialize through UI and finish an authenticated live-model workflow across workspace switching', async ({
  page,
}) => {
  test.skip(
    !process.env.LIVE_SYSTEM_VERIFY,
    'Requires a fresh verification instance with a configured real model.',
  );
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const initialized = (await (await page.request.get('/api/auth/status')).json()).initialized;
  await page.goto('/?workflow=customer-order-summary');
  if (!initialized) {
    await expect(page.getByRole('heading', { name: '创建管理员', exact: true })).toBeVisible();
    await page.screenshot({
      path: '../docs/screenshots/29-system-initialization.png',
      fullPage: true,
    });
    await page.getByLabel('显示名称', { exact: true }).fill('验收管理员');
    await page.getByLabel('确认密码', { exact: true }).fill(TEST_PASSWORD);
  }
  await page.getByLabel('用户名', { exact: true }).fill(TEST_USERNAME);
  await page.getByLabel('密码', { exact: true }).fill(TEST_PASSWORD);
  await page
    .getByRole('button', { name: initialized ? '登录' : '创建并进入工作台', exact: true })
    .click();
  await expect(page.locator('.workflow-node')).toHaveCount(6);
  const runs = await (await page.request.get('/api/workspaces/ws_legacy/runs')).json();
  const waiting = runs.find(
    (r: any) => r.agent_id === 'customer-order-summary' && r.status === 'AWAITING_INPUT',
  );
  if (waiting) await page.goto(`/?workspace=ws_legacy&run=${waiting.id}`);
  else await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.human-confirmation')).toContainText('CUST-1001', { timeout: 120000 });
  const runId = new URL(page.url()).searchParams.get('run')!;
  const session = await (await page.request.get('/api/auth/me')).json();
  const before = await (await page.request.get(`/api/workspaces/ws_legacy/runs/${runId}`)).json();
  expect(before.usage).toEqual({ model_calls: 1, tool_calls: 1 });
  expect(before.submitted_by).toBe(session.user.id);
  const created = await page.request.post('/api/workspaces', {
    headers: { 'X-CSRF-Token': session.csrf_token },
    data: { name: '运行期间切换测试' },
  });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  await page.reload();
  await expect(page.locator('.human-confirmation')).toBeVisible();
  await page.getByLabel('切换工作区').selectOption(workspace.id);
  await expect(page.locator('.empty-workspace')).toBeVisible();
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(TEST_USERNAME);
  await page.getByLabel('密码', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.goto(`/?workspace=ws_legacy&run=${runId}`);
  await expect(page.locator('.human-confirmation')).toBeVisible();
  await page.getByLabel('反馈').fill('已核对真实模型摘要与订单数据');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  const after = await (await page.request.get(`/api/workspaces/ws_legacy/runs/${runId}`)).json();
  expect(after.usage).toEqual(before.usage);
  expect(Object.keys(after.node_results)).toHaveLength(6);
  expect(after.result.approved).toBe(true);
  await page.getByTitle('系统设置').click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观与布局', exact: true })
    .click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '外观已保存' })).toBeVisible();
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const separator = page.getByRole('separator', { name: '调整执行结果高度' });
  await separator.focus();
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowUp');
  await page.getByTitle('适应画布').click();
  await page.screenshot({
    path: '../docs/screenshots/30-system-live-workflow-dark.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: /^运行事件/ }).click();
  await expect(page.locator('.event-list')).toContainText('人工确认已处理');
  await expect
    .poll(
      async () => {
        const value = await (
          await page.request.get(`/api/workspaces/ws_legacy/runs/${runId}`)
        ).json();
        return value.evaluation_status;
      },
      { timeout: 60000 },
    )
    .not.toMatch(/^(PENDING|RUNNING)$/);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({ runId, model: before.model_mode, usage: after.usage, status: after.status }),
  );
});

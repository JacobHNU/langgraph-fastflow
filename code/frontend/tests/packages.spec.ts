import { readFile } from 'node:fs/promises';
import { test, expect, TEST_PASSWORD, TEST_USERNAME } from './fixtures';

const runtimeUrl = process.env.E2E_RUNTIME_URL;

test('export release, import into installed headless Runtime, bind, confirm and activate', async ({
  page,
  browser,
}) => {
  test.skip(!runtimeUrl, 'Set E2E_RUNTIME_URL to a separate installed Runtime test instance');
  const errors: string[] = [];
  const source = await (await page.request.get('/api/agents/order-integration-lab')).json();
  await page.goto('/?workflow=order-integration-lab');
  await page.locator('.version-select').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 .tar.gz', exact: true }).first().click(),
  ]);
  const data = await readFile((await download.path())!);
  expect(data.length).toBeGreaterThan(1000);
  await page.screenshot({ path: '../docs/screenshots/36-m12-studio-export.png', fullPage: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const target = await context.newPage();
  target.on('pageerror', (error) => errors.push(error.message));
  await target.goto(runtimeUrl!);
  await target.getByLabel('用户名', { exact: true }).fill(TEST_USERNAME);
  const setup = target.getByLabel('显示名称', { exact: true });
  if (await setup.count()) await setup.fill('Runtime 验收管理员');
  await target.getByLabel(/密码/).fill(TEST_PASSWORD);
  await target.getByRole('button', { name: /^(登录|创建管理员)$/ }).click();
  await expect(target.getByRole('heading', { name: '发布包', exact: true })).toBeVisible();
  await target
    .getByLabel('选择发布包')
    .setInputFiles({ name: 'workflow.tar.gz', mimeType: 'application/gzip', buffer: data });
  await target.getByRole('button', { name: '校验并预览' }).click();
  await expect(target.getByRole('heading', { name: '导入预览' })).toBeVisible();
  await target.screenshot({
    path: '../docs/screenshots/37-m12-import-preview.png',
    fullPage: true,
  });
  await target.getByLabel('我已核对发布者，信任此未签名发布包').check();
  await target.getByRole('button', { name: '确认导入', exact: true }).click();
  await target.getByRole('button', { name: '模型与连接', exact: true }).click();
  const connection = target.locator('section.detail');
  const connectionName = 'Runtime 独立订单服务 ' + Date.now();
  await connection.getByLabel('连接名称', { exact: true }).fill(connectionName);
  await connection
    .getByLabel('服务地址', { exact: true })
    .fill(process.env.E2E_ORDERS_URL || 'http://127.0.0.1:18765');
  await connection.getByLabel('确认目标接口符合源合同，且所有 POST 操作均为只读查询').check();
  await target.getByRole('button', { name: '保存 HTTP 连接', exact: true }).click();
  await expect(target.getByRole('status')).toContainText('已保存目标连接');
  await target.getByRole('button', { name: '发布包', exact: true }).click();
  await target
    .locator('.row')
    .filter({ hasText: source.name })
    .getByRole('button', { name: '查看', exact: true })
    .first()
    .click();
  await target.getByLabel(/^模型 · /).selectOption('model_default@1');
  const available = await target
    .getByLabel(/^HTTP 连接 · /)
    .locator('option')
    .allTextContents();
  const savedConnection = available.find((label) => label.includes(connectionName));
  expect(savedConnection).toBeDefined();
  await target.getByLabel(/^HTTP 连接 · /).selectOption({ label: savedConnection! });
  await target.getByLabel('授权此部署使用所选目标资源及其凭据').check();
  const deploymentName = '可移植七节点验收 ' + Date.now();
  await target.getByLabel('部署名称', { exact: true }).fill(deploymentName);
  await target.getByRole('button', { name: '保存绑定并创建部署', exact: true }).click();
  await expect(target.getByRole('heading', { name: deploymentName })).toBeVisible();
  await target.screenshot({
    path: '../docs/screenshots/38-m12-bound-deployment.png',
    fullPage: true,
  });
  await target.getByRole('button', { name: '试运行', exact: true }).click();
  await expect(target.getByRole('heading', { name: '等待人工确认' })).toBeVisible({
    timeout: 25000,
  });
  await target.getByLabel('反馈 JSON').fill('{"feedback":"已核对可移植运行结果"}');
  await target.waitForTimeout(2100);
  await expect(target.getByLabel('反馈 JSON')).toHaveValue('{"feedback":"已核对可移植运行结果"}');
  await target.getByRole('button', { name: '确认', exact: true }).click();
  await expect(target.getByRole('heading', { name: '执行成功' })).toBeVisible({ timeout: 20000 });
  await expect(target.locator('main')).toContainText('ORD-1001');
  await expect(target.getByText('评估 · 评估通过', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await target.screenshot({
    path: '../docs/screenshots/39-m12-runtime-completed.png',
    fullPage: true,
  });
  const runUrl = target.url();
  await target.getByRole('button', { name: '部署', exact: true }).click();
  await target
    .locator('.row')
    .filter({ hasText: deploymentName })
    .getByRole('button', { name: '查看' })
    .click();
  await target.getByRole('button', { name: '启用', exact: true }).click();
  await expect(target.locator('section.detail')).toContainText('ACTIVE');
  await target.goto(runUrl);
  await expect(target.getByRole('heading', { name: '执行成功' })).toBeVisible();
  await target.setViewportSize({ width: 390, height: 844 });
  expect(
    await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await target.screenshot({
    path: '../docs/screenshots/40-m12-runtime-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await context.close();
});

test('installed Runtime displays the completed real-model portable workflow', async ({
  browser,
}) => {
  test.skip(
    !process.env.LIVE_M12_VERIFY || !runtimeUrl,
    'Requires the opt-in portable live verification',
  );
  const result = JSON.parse(await readFile('../dist/m12-live-verification.json', 'utf8'));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const login = await page.request.post(runtimeUrl + '/api/auth/login', {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto(runtimeUrl + '/?workspace=ws_legacy&tab=runs&selected=' + result.run_id);
  await expect(page.getByRole('heading', { name: '执行成功', exact: true })).toBeVisible();
  await expect(page.getByText('在线模型', { exact: true })).toBeVisible();
  await expect(page.getByText('评估 · 评估通过', { exact: true })).toBeVisible();
  await page.getByText('执行快照', { exact: true }).click();
  await page.screenshot({ path: '../docs/screenshots/41-m12-live-runtime.png', fullPage: true });
  await page.getByText(/^运行事件 ·/).click();
  await expect(page.locator('main')).toContainText('model.completed');
  await expect(page.locator('main')).toContainText('qwen3.8-max');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: '../docs/screenshots/42-m12-live-runtime-mobile.png',
    fullPage: true,
  });
  await context.close();
});

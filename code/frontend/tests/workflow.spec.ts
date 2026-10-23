import { test, expect, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.locator('.workflow-node')).toHaveCount(4);
}
async function choose(page: Page, name: string) {
  await page.locator('.agent-link').filter({ hasText: name }).first().click();
}
async function execute(page: Page) {
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
    timeout: 30000,
  });
}

test('query runs through LangGraph, streams events and displays evidence/evaluation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await execute(page);
  await expect(page.locator('.workflow-node.completed')).toHaveCount(4);
  await expect(page.locator('.project-result')).toContainText('企业门户升级');
  await expect(page.locator('.usage-stats')).toContainText('模型调用 0');
  await page.screenshot({ path: '../docs/screenshots/02-query-result.png', fullPage: true });
  await page.getByRole('button', { name: /运行事件/ }).click();
  await expect(page.locator('.event-list')).toContainText('LangGraph 启动');
  await page.screenshot({ path: '../docs/screenshots/03-live-events.png', fullPage: true });
  await page.getByRole('button', { name: '证据', exact: true }).click();
  await expect(page.locator('.evidence-list details').first()).toBeVisible();
  await page.getByRole('button', { name: '评估报告', exact: true }).click();
  await expect(page.locator('.evaluation-report')).toContainText('离线评估示例', {
    timeout: 15000,
  });
  expect(errors).toEqual([]);
});

test('node form, drag, save and immutable publishing from the actual canvas', async ({ page }) => {
  await open(page);
  await page.getByTitle('复制当前流程为新草稿').click();
  await expect(page.locator('.workflow-breadcrumb')).toContainText('副本');
  const target = page.locator('.workflow-node[data-node-id="n_query"]');
  await target.click();
  await page.getByLabel('节点名称').fill('查询项目状态 · 编排测试');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(target).toContainText('编排测试');
  await page.getByTitle('关闭节点配置').click();
  const before = await target.boundingBox();
  if (!before) throw new Error('No draggable node');
  await page.mouse.move(before.x + 70, before.y + 55);
  await page.mouse.down();
  await page.mouse.move(before.x + 70, before.y - 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await target.boundingBox())!.y).toBeLessThan(before.y - 20);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  await page.getByRole('button', { name: '校验', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('流程校验通过');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已发布不可变版本');
  await execute(page);
  await expect(target).toContainText('编排测试');
});

test('add a Python node and reconnect the graph through visual ports', async ({ page }) => {
  await open(page);
  await page.getByTitle('复制当前流程为新草稿').click();
  await expect(page.locator('.workflow-breadcrumb')).toContainText('副本');
  await page.getByTitle('添加节点').click();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: 'Python 函数' }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(5);
  const added = page
    .locator('.workflow-node')
    .filter({ has: page.locator('code', { hasText: /^n_python_/ }) });
  const addedId = await added.getAttribute('data-node-id');
  expect(addedId).toBeTruthy();
  await page.getByTitle('关闭节点配置').click();
  await page.waitForTimeout(500); // Allow the fit-view transition after adding the node to settle.
  const path = page.locator('[data-line-id="n_query_-n_verify_"] svg g path').first();
  const box = await path.boundingBox();
  if (!box) throw new Error('No existing connection');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-line-id="n_query_-n_verify_"]')).toHaveCount(0);
  for (const [from, to] of [
    ['n_query', addedId!],
    [addedId!, 'n_verify'],
  ]) {
    const source = await page.locator(`[data-port-entity-id="port_output_${from}_"]`).boundingBox();
    const target = await page.locator(`[data-port-entity-id="port_input_${to}_"]`).boundingBox();
    if (!source || !target) throw new Error('Missing workflow port');
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
    await page.mouse.up();
    await expect(page.locator(`[data-line-id="${from}_-${to}_"]`)).toHaveCount(1);
  }
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已发布不可变版本');
  await execute(page);
  await expect(page.locator('.workflow-node.completed')).toHaveCount(5);
  await page.screenshot({ path: '../docs/screenshots/07-custom-workflow.png', fullPage: true });
});

test('human approval resumes the checkpoint and verifies a write', async ({ page }) => {
  await open(page);
  await choose(page, '测试数据修改');
  await page.getByLabel('目标进度（%）').fill('84');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.approval-banner')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.approval-banner')).toContainText('84%');
  await page.screenshot({ path: '../docs/screenshots/04-approval-pause.png', fullPage: true });
  await page.getByRole('button', { name: '批准并继续' }).click();
  await expect(page.locator('.result-overview')).toContainText('执行成功', { timeout: 20000 });
  await expect(page.locator('.progress-result')).toContainText('84');
});

test('Deep Agents uses the real library, read-only tools, Skill and conversation context', async ({
  page,
}) => {
  await open(page);
  await choose(page, 'Deep Agents 分析');
  await page.getByLabel('任务材料').fill('请查询 PRJ-1001 的项目进度，分析阻塞与交付风险。');
  await execute(page);
  await expect(page.locator('.analysis-result')).toContainText('deep_agent');
  await expect(page.locator('.usage-stats')).toContainText('模型调用 2');
  await page.screenshot({ path: '../docs/screenshots/05-deep-agent.png', fullPage: true });
  await page.getByLabel('任务材料').fill('继续分析刚才项目，给出两个优先处理的建议。');
  await execute(page);
  await expect(page.locator('.analysis-result')).toContainText('离线演示模型');
});

test('mobile layout shows a real canvas and can run a query', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await execute(page);
  await page.screenshot({ path: '../docs/screenshots/06-mobile.png', fullPage: true });
  const sizes = await page.evaluate(() => ({ body: document.body.scrollWidth, width: innerWidth }));
  expect(sizes.body).toBeLessThanOrEqual(sizes.width);
  await expect(page.locator('.project-result')).toContainText('企业门户升级');
});

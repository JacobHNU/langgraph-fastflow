import { test, expect, type Page } from '@playwright/test';

async function send(page: Page, text: string) {
  await page.getByLabel('编排需求').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.assistant-pending')).toHaveCount(0, { timeout: 20000 });
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

async function publishAndRun(page: Page) {
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('无副作用预检通过');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
    timeout: 20000,
  });
}

test('new workflow can be assembled manually, run, renamed, archived and restored', async ({
  page,
}) => {
  const name = `手动创建-${Date.now()}`;
  await page.goto('/');
  await page.getByTitle('新建工作流菜单', { exact: true }).click();
  await page.getByRole('button', { name: '新建工作流', exact: true }).click();
  await page.getByLabel('工作流名称', { exact: true }).fill(name);
  await page.getByLabel('流程类型', { exact: true }).selectOption('1.0');
  await page.getByRole('button', { name: '创建工作流', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('草稿已保存');
  await page.getByTitle('添加节点').click();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: 'Python 函数' }).click();
  const query = await page.locator('.workflow-node.type-python').getAttribute('data-node-id');
  await page.getByTitle('添加节点').click();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: '业务核验' }).click();
  const verify = await page.locator('.workflow-node.type-verify').getAttribute('data-node-id');
  await page.getByLabel('result 来源').selectOption(query!);
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTitle('关闭节点配置').click();
  await page.locator('.workflow-node[data-node-id="n_output"]').click();
  await page.getByLabel('result 来源').selectOption(query!);
  await page.getByLabel('verification 来源').selectOption(verify!);
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTitle('关闭节点配置').click();
  await page.getByTitle('自动布局').click();
  await page.waitForTimeout(500);
  await connect(page, 'n_input', query!);
  await connect(page, query!, verify!);
  await connect(page, verify!, 'n_output');
  await publishAndRun(page);
  await expect(page.locator('.project-result')).toContainText('企业门户升级');
  await page.getByRole('button', { name: '业务 Agent', exact: true }).click();
  await page.getByLabel('搜索管理工作流').fill(name);
  await page.getByTitle(`编辑 ${name}`, { exact: true }).click();
  const renamed = name + '已命名';
  await page.getByLabel('工作流名称', { exact: true }).fill(renamed);
  await page.getByLabel('工作流描述').fill('从输入和输出开始手动编排');
  await page.getByRole('button', { name: '保存信息', exact: true }).click();
  await expect(page.locator('.management-table')).toContainText(renamed);
  await page.getByTitle(`删除 ${renamed}`, { exact: true }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '业务 Agent', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByLabel('搜索管理工作流').fill(renamed);
  await expect(page.locator('.management-table')).toContainText(renamed);
  await page.screenshot({ path: '../docs/screenshots/14-workflow-trash.png', fullPage: true });
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByRole('button', { name: '工作流', exact: true }).last().click();
  await expect(page.locator('.management-table')).toContainText(renamed);
});

test('evaluation links stable numbered evidence and events point to the same records', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.locator('.result-overview').first()).toContainText('执行成功', {
    timeout: 20000,
  });
  await page.getByRole('button', { name: '评估报告', exact: true }).click();
  await expect(page.locator('.evaluation-facts')).toContainText('关联证据：');
  const link = page.locator('.report-evidence .evidence-link').last();
  const label = await link.innerText();
  await link.click();
  const selected = page.locator('.evidence-list .highlight-evidence');
  await expect(selected).toHaveAttribute('open', '');
  await expect(selected).toContainText(label.replace(' · ', ''));
  const id = await selected.getAttribute('id');
  await expect(selected.locator('.evidence-metadata')).toContainText('SHA-256');
  await page.screenshot({ path: '../docs/screenshots/13-evidence-navigation.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '评估报告', exact: true }).click();
  await page.locator('.report-evidence .evidence-link').filter({ hasText: label }).click();
  await expect(page.locator('.highlight-evidence')).toHaveAttribute('id', id!);
  await page.getByRole('button', { name: /运行事件/ }).click();
  await page.locator('.event-evidence .evidence-link').filter({ hasText: label }).first().click();
  await expect(page.locator('.highlight-evidence')).toHaveAttribute('id', id!);
});

test('chat previews, applies and undoes edits, rejects stale proposals and creates runnable workflows', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await send(page, '增加分析节点');
  await expect(page.locator('.workflow-proposal')).toContainText('多轮工具分析');
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await page
    .locator('.workflow-proposal')
    .getByRole('button', { name: '应用修改', exact: true })
    .click();
  await expect(page.locator('.workflow-node')).toHaveCount(5);
  await page.getByRole('button', { name: '撤销此次应用', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await send(page, '增加分析节点');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存的修改' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.locator('.workflow-node[data-node-id="n_query"]').click();
  await page.getByLabel('节点名称').fill('查询节点已修改');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page
    .locator('.workflow-proposal')
    .last()
    .getByRole('button', { name: '应用修改', exact: true })
    .click();
  await expect(page.locator('.assistant-error')).toContainText('提案已过期');
  await page.getByRole('button', { name: '业务 Agent', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '未保存的修改' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建工作流', exact: true }).click();
  await send(page, '新建查询流程');
  await page.getByLabel('提案工作流名称').fill(`对话生成-${Date.now()}`);
  await page
    .locator('.workflow-proposal')
    .getByRole('button', { name: '创建工作流', exact: true })
    .click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.locator('.workflow-breadcrumb')).toContainText('对话生成');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await send(page, '增加分析节点');
  await page
    .locator('.workflow-proposal')
    .getByRole('button', { name: '应用修改', exact: true })
    .click();
  await expect(page.locator('.workflow-node')).toHaveCount(5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '../docs/screenshots/15-workflow-assistant.png', fullPage: true });
  await publishAndRun(page);
  await expect(page.getByLabel('编排需求')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '../docs/screenshots/16-assistant-mobile.png', fullPage: true });
});

test('empty workspace remains usable and can create a workflow', async ({ page }) => {
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [] });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('暂无工作流', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByRole('button', { name: '新建工作流', exact: true }).click();
  await page.getByLabel('工作流名称', { exact: true }).fill('空工作空间创建');
  await page.getByRole('button', { name: '创建工作流', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);
});

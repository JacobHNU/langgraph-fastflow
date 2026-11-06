import { test, expect, TEST_PASSWORD, TEST_USERNAME } from './fixtures';

async function category(page: any, name: string) {
  if (
    await page
      .getByRole('combobox', { name: '设置分类', exact: true })
      .isVisible()
      .catch(() => false)
  )
    await page
      .getByRole('combobox', { name: '设置分类', exact: true })
      .selectOption({ label: name });
  else
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
}

test('appearance persists, follows system, and styles the workflow canvas', async ({ page }) => {
  await page.goto('/?settings=appearance');
  await expect(page.getByRole('heading', { name: '外观与布局', exact: true })).toBeVisible();
  await page.screenshot({
    path: '../docs/screenshots/23-system-settings-light.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('status')).toContainText('外观已保存');
  await page.getByRole('button', { name: '强调色：蓝', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '强调色：蓝', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({
    path: '../docs/screenshots/24-system-settings-dark.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  const colors = await page
    .locator('.workflow-node')
    .first()
    .evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    }));
  expect(colors.background).toBe('rgb(27, 32, 30)');
  expect(colors.color).toBe('rgb(236, 240, 237)');
  await expect(page.locator('.gedit-playground')).toHaveCSS('background-color', 'rgb(21, 26, 23)');
  await expect(page.locator('.gedit-grid-svg circle').first()).toHaveCSS(
    'stroke',
    'rgb(59, 70, 64)',
  );
  await page.screenshot({ path: '../docs/screenshots/25-workflow-dark.png', fullPage: true });
  await page.getByTitle('系统设置').click();
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '恢复默认面板尺寸' }).click();
  await expect(page.getByRole('status')).toContainText('面板尺寸已恢复默认');
});

test('profile changes use save, discard and cancel before navigation', async ({ page }) => {
  await page.goto('/?settings=account');
  await expect(page.getByRole('form', { name: '个人资料' })).toBeVisible();
  const original = await page.getByLabel('显示名称', { exact: true }).inputValue();
  await page.getByLabel('显示名称', { exact: true }).fill(original + '修改');
  await category(page, '外观与布局');
  const dialog = page.getByRole('dialog', { name: '未保存的设置' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue(original + '修改');
  await category(page, '外观与布局');
  await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
  await category(page, '个人账号');
  await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue(original);
  await page.getByLabel('显示名称', { exact: true }).fill(original + '已保存');
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  await expect(page.getByRole('menu')).toContainText(original + '已保存');
  await page.getByRole('menuitem', { name: '个人账号', exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill(original);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('个人资料已保存');
});

test('workspace creation, empty state, scoped drafts, archive and restore', async ({ page }) => {
  const name = `个人工作区-${Date.now()}`;
  await page.goto('/?settings=workspaces');
  await page.getByRole('button', { name: '新建工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作区', exact: true });
  await dialog.getByLabel('工作区名称', { exact: true }).fill(name);
  await dialog.getByLabel('工作区描述', { exact: true }).fill('浏览器隔离测试');
  await dialog.getByRole('button', { name: '创建工作区', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.locator('.settings-data-row').filter({ hasText: name });
  const workspaceId = await row.locator('code').textContent();
  await row.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('.empty-workspace')).toBeVisible();
  await expect(page.getByLabel('切换工作区')).toHaveValue(workspaceId!);
  await page.getByRole('button', { name: '新建工作流', exact: true }).first().click();
  await page.getByLabel('工作流名称', { exact: true }).fill('仅在新工作区');
  await page.getByRole('button', { name: '创建工作流', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);
  const currentAgents = await (
    await page.request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  expect(currentAgents).toHaveLength(1);
  const legacyAgents = await (await page.request.get('/api/workspaces/ws_legacy/agents')).json();
  expect(legacyAgents.some((a: any) => a.name === '仅在新工作区')).toBe(false);
  await page.getByTitle('管理工作区').click();
  await page.screenshot({
    path: '../docs/screenshots/26-workspace-management.png',
    fullPage: true,
  });
  page.once('dialog', (d) => d.accept());
  await page.getByTitle(`归档 ${name}`, { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '工作区已归档' })).toBeVisible();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByTitle(`恢复 ${name}`, { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '工作区已恢复' })).toBeVisible();
  await page.getByLabel('切换工作区').selectOption('ws_legacy');
  await expect(page.locator('.workflow-node')).toHaveCount(4);
});

test('admin provisions a user, who changes temporary password and sees only personal workspaces', async ({
  page,
  browser,
}) => {
  const username = `user${Date.now()}`;
  await page.goto('/?settings=users');
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '创建用户', exact: true });
  await modal.getByLabel('登录用户名', { exact: true }).fill(username);
  await modal.getByLabel('显示名称', { exact: true }).fill('独立用户');
  await modal.getByLabel('临时密码', { exact: true }).fill(TEST_PASSWORD);
  await modal.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.settings-data-row').filter({ hasText: username })).toContainText(
    '待修改密码',
  );
  await page.screenshot({ path: '../docs/screenshots/27-user-management.png', fullPage: true });
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await other.goto(new URL('/', page.url()).href);
    await other.getByLabel('用户名', { exact: true }).fill(username);
    await other.getByLabel('密码', { exact: true }).fill(TEST_PASSWORD);
    await other.getByRole('button', { name: '登录', exact: true }).click();
    await expect(other.getByRole('heading', { name: '修改临时密码', exact: true })).toBeVisible();
    await other.getByLabel('当前密码', { exact: true }).fill(TEST_PASSWORD);
    await other.getByLabel('新密码', { exact: true }).fill(TEST_PASSWORD + '-changed');
    await other.getByLabel('确认新密码', { exact: true }).fill(TEST_PASSWORD + '-changed');
    await other.getByRole('button', { name: '修改密码并重新登录', exact: true }).click();
    await other.getByLabel('用户名', { exact: true }).fill(username);
    await other.getByLabel('密码', { exact: true }).fill(TEST_PASSWORD + '-changed');
    await other.getByRole('button', { name: '登录', exact: true }).click();
    await expect(other.locator('.empty-workspace')).toBeVisible();
    await expect(other.getByLabel('切换工作区').locator('option')).toHaveCount(1);
    expect(
      (
        await other.request.get(new URL('/api/workspaces/ws_legacy/agents', page.url()).href)
      ).status(),
    ).toBe(404);
    await other.getByTitle('系统设置').click();
    await expect(
      other
        .getByRole('navigation', { name: '设置分类' })
        .getByRole('button', { name: '用户管理', exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('expired session locks a dirty canvas and same-user login restores it', async ({ page }) => {
  await page.goto('/');
  await page.locator('.workflow-node[data-node-id="n_query"]').click();
  await page.getByLabel('节点名称', { exact: true }).fill('未保存的会话恢复测试');
  await page.getByRole('button', { name: '应用修改', exact: true }).click();
  await page.getByTitle('关闭节点配置').click();
  await page.request.post('/api/auth/logout');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const lock = page.locator('.auth-lock');
  await expect(lock).toBeVisible();
  await expect(lock.getByLabel('用户名', { exact: true })).toHaveValue(TEST_USERNAME);
  await lock.getByLabel('密码', { exact: true }).fill(TEST_PASSWORD);
  await lock.getByRole('button', { name: '登录', exact: true }).click();
  await expect(lock).toHaveCount(0);
  await expect(page.locator('.workflow-node[data-node-id="n_query"]')).toContainText(
    '未保存的会话恢复测试',
  );
  await expect(page.locator('.unsaved-dot')).toBeVisible();
});

test('mobile settings remain within viewport in dark and light themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?settings=appearance');
  await expect(page.getByRole('combobox', { name: '设置分类', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  expect((await page.getByLabel('切换工作区').boundingBox())!.width).toBeGreaterThan(90);
  await page.screenshot({
    path: '../docs/screenshots/28-system-settings-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await category(page, '个人账号');
  await expect(page.getByLabel('登录用户名', { exact: true })).toBeVisible();
  await category(page, '工作区管理');
  await expect(page.getByRole('heading', { name: '工作区管理', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

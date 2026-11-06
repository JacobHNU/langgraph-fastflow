import { test as base, expect } from '@playwright/test';
export type { Page } from '@playwright/test';
export { expect };
export const TEST_USERNAME = 'e2eadmin';
export const TEST_PASSWORD = 'Browser-test-password-2026';

export const test = base.extend({
  page: async ({ page }, use) => {
    const initialized = (await (await page.request.get('/api/auth/status')).json()).initialized;
    const response = await page.request.post(initialized ? '/api/auth/login' : '/api/auth/setup', {
      data: {
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        ...(!initialized ? { display_name: '测试管理员' } : {}),
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const session = await response.json();
    await page.context().setExtraHTTPHeaders({ 'X-CSRF-Token': session.csrf_token });
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const original = page.request[method].bind(page.request);
      page.request[method] = (url, options = {}) =>
        original(url, {
          ...options,
          headers: { 'X-CSRF-Token': session.csrf_token, ...options.headers },
        });
    }
    await page.request.put('/api/me/preferences', {
      data: { theme: 'light', accent: 'teal', default_workspace_id: 'ws_legacy' },
    });
    // This fixture only authenticates the dedicated E2E account and resets its test model.
    const reset = await page.request.put('/api/workspaces/ws_legacy/settings/model', {
      data: {
        mode: 'demo',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        base_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        timeout_seconds: 35,
        max_tokens: 1800,
        temperature: null,
        clear_api_key: true,
      },
    });
    expect(reset.ok(), await reset.text()).toBeTruthy();
    await use(page);
  },
});

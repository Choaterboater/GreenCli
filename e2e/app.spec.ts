import { test, expect } from '@playwright/test';

test('has title and renders sidebar', async ({ page }) => {
  await page.goto('/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/GreenCLI/i);

  // Expect the sidebar to be visible (look for standard icons/buttons like Quick Connect)
  const quickConnectBtn = page.getByRole('button', { name: 'Quick Connect' }).first();
  await expect(quickConnectBtn).toBeVisible();
});

import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';

const widths = [320, 414, 1440];

for (const width of widths) {
  test(`notification settings render outside the shell at ${width}px`, async ({ page, world }) => {
    world.restriction = 'notification_settings';
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/notification-settings');
    await expect(page.getByRole('heading', { name: 'Your notification settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Allow News & events' })).toBeChecked();
    await expect(page.getByText('Monthly newsletter')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    // A restricted session gets no shell and no link into the app.
    await expect(page.locator('.cds--side-nav')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open in the app' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);
  });
}

test('a restricted session is sent from the application to the settings page', async ({ page, world }) => {
  world.restriction = 'notification_settings';
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/notification-settings$/);
  await expect(page.getByRole('heading', { name: 'Your notification settings', level: 1 })).toBeVisible();
});

test('a change is saved with the allowed endpoint', async ({ page, world }) => {
  world.restriction = 'notification_settings';
  await page.goto('/notification-settings');
  await expect(page.getByRole('switch', { name: 'Ask me at check-out' })).toBeChecked();
  // Carbon's toggle is operated through its label.
  await page.locator('#mn-feedback-at-checkout_label').click();
  await expect
    .poll(() =>
      world.requests.some(
        (request) => request.path === '/api/v1/me/notifications/feedback-at-checkout' && request.method === 'PUT',
      ),
    )
    .toBe(true);
});

test('a full session is offered the subscriptions in the app', async ({ page }) => {
  await page.goto('/notification-settings');
  await expect(page.getByRole('link', { name: 'Open in the app' })).toBeVisible();
});

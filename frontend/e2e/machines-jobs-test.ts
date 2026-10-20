import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import { createWorld, installMachinesJobsApi, staffPermissions, type World } from './machines-jobs-api';

type Fixtures = { userPermissions: string[]; world: World; pageErrors: string[] };

/**
 * `world` is the stateful mock API of the page under test (see machines-jobs-api.ts). Override `userPermissions` with
 * `test.use` for role-gating tests. A test fails when the app throws or requests an endpoint the mock does not know.
 */
export const test = base.extend<Fixtures>({
  userPermissions: [staffPermissions, { option: true }],
  pageErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // Failed resource loads are expected for the mocked 404s (a machine without a printer profile).
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(message.text());
    });
    await provide(errors);
    expect(errors).toEqual([]);
  },
  world: [
    async ({ page, userPermissions, pageErrors }, provide) => {
      void pageErrors;
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const world = await installMachinesJobsApi(page, createWorld(userPermissions));
      await provide(world);
      expect(world.unhandled).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** WCAG 2.x A/AA scan; the failure message names rule, impact and targets so a violation can be reported precisely. */
export async function expectNoAccessibilityViolations(page: Page, scope?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (scope) builder = builder.include(scope);
  const { violations } = await builder.analyze();
  const summary = violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
  expect(summary).toEqual([]);
}

/** The page itself must not scroll sideways (wide tables scroll inside their own container). Polls because responsive components settle after a resize. */
export async function expectNoHorizontalScroll(page: Page) {
  const measure = () =>
    page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  await expect
    .poll(
      async () => {
        const { scrollWidth, innerWidth } = await measure();
        return scrollWidth - innerWidth;
      },
      { message: 'the page scrolls horizontally', timeout: 3000 },
    )
    .toBeLessThanOrEqual(0);
}

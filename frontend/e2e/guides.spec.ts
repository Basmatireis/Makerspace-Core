import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSalesWorld, installSalesApi, salesPermissions } from './sales-api';

/**
 * Guided tours, workflow demos and the help center in a real browser. The API is mocked with page.route (the sales
 * world of sales-api.ts serves the shell and the real-mode data); demo guides must never reach it with a write.
 * Set GUIDE_SCREENSHOTS to a directory to also write screenshots of representative steps.
 */

const screenshotDirectory = process.env.GUIDE_SCREENSHOTS;

const allPermissions = [
  ...new Set([
    ...salesPermissions,
    'machine_jobs.create',
    'machine_jobs.edit',
    'inventory.manage',
    'inventory.purchase',
    'organizations.read',
    'people.read.all',
    'open_days.read',
    'open_days.read_assignments',
    'open_days.signup',
    'open_days.assign',
    'open_days.manage',
  ]),
];

type ProgressItem = { guideId: string; status: string; updatedAt: string };
interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  progress: ProgressItem[];
  progressPuts: Array<{ guideId: string; status: string }>;
  requests: Recorded[];
  errors: string[];
}

async function installApi(page: Page, permissions: string[], initial: ProgressItem[] = []): Promise<Harness> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const harness: Harness = { progress: [...initial], progressPuts: [], requests: [], errors: [] };
  page.on('pageerror', (error) => harness.errors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    // Failed resource loads are the mocked 4xx/5xx answers; real crashes log through console.error.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      harness.errors.push(message.text());
    }
  });
  await installSalesApi(page, createSalesWorld(permissions));
  // Registered last, so it sees every request first and hands the rest to the sales world.
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    harness.requests.push({
      method: request.method(),
      path,
      body: request.method() === 'GET' ? undefined : request.postData(),
    });
    if (path === '/api/v1/me/dashboard') {
      return route.fulfill({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ person: { firstName: 'Lena', memberSince: '2025-09-01' }, comingUp: [] }),
      });
    }
    const guide = path.match(/^\/api\/v1\/me\/guides(?:\/([^/]+))?$/);
    if (!guide) return route.fallback();
    const headers = { 'content-type': 'application/json' };
    if (request.method() === 'GET') {
      return route.fulfill({ headers, body: JSON.stringify({ items: harness.progress }) });
    }
    if (request.method() === 'PUT' && guide[1]) {
      const { status } = request.postDataJSON() as { status: string };
      harness.progressPuts.push({ guideId: guide[1], status });
      harness.progress = [
        ...harness.progress.filter((item) => item.guideId !== guide[1]),
        { guideId: guide[1], status, updatedAt: '2026-11-04T10:00:00Z' },
      ];
      return route.fulfill({ headers, body: JSON.stringify(harness.progress.at(-1)) });
    }
    if (request.method() === 'DELETE') {
      harness.progress = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405, headers, body: '{"code":"method_not_allowed","message":"no"}' });
  });
  return harness;
}

async function shot(page: Page, name: string) {
  if (!screenshotDirectory) return;
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: join(screenshotDirectory, `${name}.png`) });
}

async function expectNoSeriousViolations(page: Page, scope?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (scope) builder = builder.include(scope);
  const { violations } = await builder.analyze();
  const serious = violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious).toEqual([]);
}

/** The page cannot be scrolled sideways (off-canvas parts that never scroll do not count). */
async function expectNoHorizontalScroll(page: Page) {
  const scrolled = await page.evaluate(() => {
    window.scrollTo(400, window.scrollY);
    const x = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return x;
  });
  expect(scrolled).toBe(0);
}

// Guide helpers ---------------------------------------------------------------------------------------------------

const live = (page: Page) => page.locator('.guide-live');
const panel = (page: Page) => page.locator('.guide-panel, .guide-modal .cds--modal-container');
const demoBanner = (page: Page) => page.getByText('Demo mode', { exact: true });

type Box = { x: number; y: number; width: number; height: number };

/** The distance between two rectangles; zero when they touch or overlap. */
function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectInViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await boxOf(locator);
        return (
          box.x >= -1 &&
          box.y >= -1 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1
        );
      },
      { message: 'panel inside the viewport' },
    )
    .toBe(true);
}

/** The popover sits next to its spotlight (and, on a narrow screen, inside the viewport). */
async function expectPopoverNearTarget(page: Page, inViewport: boolean) {
  const spotlight = page.locator('.guide-spotlight');
  await expect(spotlight).toBeVisible();
  const popover = page.locator('.guide-panel');
  await expect(popover).toBeVisible();
  await expect
    .poll(async () => gap(await boxOf(spotlight), await boxOf(popover)), { message: 'popover next to its target' })
    .toBeLessThanOrEqual(48);
  if (inViewport) await expectInViewport(page, popover);
}

type StepAction = (page: Page) => Promise<void>;

interface RunOptions {
  /** Screenshot name prefix; steps (0-based, -1 for the last) listed in `shots` are captured. */
  name: string;
  shots?: number[];
  actions?: Record<string, StepAction>;
  narrow?: boolean;
  /** Called once the last step shows, while demo mode is still on. */
  atLastStep?: (page: Page) => Promise<void>;
}

/** Walks the running guide to its end the way a person would; returns the step titles. */
async function walkGuide(page: Page, options: RunOptions): Promise<string[]> {
  const titles: string[] = [];
  for (let index = 0; ; index += 1) {
    await expect(live(page)).toHaveText(new RegExp(`^Step ${index + 1} of \\d+: `), { timeout: 15_000 });
    const text = (await live(page).textContent()) ?? '';
    const [, total, title] = text.match(/^Step \d+ of (\d+): (.*)$/)!;
    titles.push(title);
    const last = index + 1 === Number(total);
    await expect(panel(page)).toBeVisible();
    if (await page.locator('.guide-spotlight').count()) await expectPopoverNearTarget(page, options.narrow === true);
    if (options.narrow) {
      await expectInViewport(page, panel(page));
      await expectNoHorizontalScroll(page);
    }
    if (options.shots?.includes(index) || (last && options.shots?.includes(-1))) {
      await page.waitForTimeout(150);
      await shot(page, `${options.name}-${String(index + 1).padStart(2, '0')}`);
    }
    if (last) await options.atLastStep?.(page);
    const action = options.actions?.[title];
    if (action) {
      await action(page);
    } else {
      const button = panel(page).getByRole('button', { name: last ? 'Done' : 'Next', exact: true });
      await expect(button, `step "${title}" needs an action (no Next button)`).toBeVisible();
      await button.click();
    }
    if (last) return titles;
  }
}

/** Finishing the guide: the popover and the demo banner are gone and the help center shows real data again. */
async function expectBackToReal(page: Page) {
  await expect(live(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(demoBanner(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/help$/);
}

async function startFromHelp(page: Page, title: string) {
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
  const card = page.locator('.help-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card.getByRole('button', { name: 'Start' }).click();
}

/** Only public branding reads may leave the browser in demo mode, and nothing is ever written. */
function expectNothingWritten(harness: Harness, from: number, to: number) {
  const during = harness.requests.slice(from, to);
  expect(during.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(
    during.filter(
      (request) => request.method === 'GET' && !/^\/api\/v1\/public\/(config|legal\/|branding\/)/.test(request.path),
    ),
  ).toEqual([]);
}

// Tests ---------------------------------------------------------------------------------------------------------

test.describe('welcome offer and tour', () => {
  test('offers the welcome tour once, runs it to the end and records completion', async ({ page }) => {
    const harness = await installApi(page, allPermissions);
    await page.goto('/dashboard');
    const offer = page.getByRole('status').filter({ hasText: 'New here?' });
    await expect(offer).toBeVisible();
    await shot(page, 'welcome-offer');
    await offer.getByRole('button', { name: 'Start tour' }).click();
    await expect(offer).toHaveCount(0);

    const titles = await walkGuide(page, { name: 'welcome', shots: [0, 3, -1] });
    expect(titles).toEqual([
      'The side navigation',
      'Help is always here',
      'Notifications',
      'Your profile menu',
      'Your dashboard',
      'Want to see more?',
    ]);
    await expect(page).toHaveURL(/\/help$/);
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => harness.progressPuts).toEqual([{ guideId: 'welcome', status: 'completed' }]);
    await expect(offer).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
    await expect(offer).toHaveCount(0);
  });

  test('"Not now" records the offer as dismissed and it does not come back', async ({ page }) => {
    const harness = await installApi(page, allPermissions);
    await page.goto('/dashboard');
    const offer = page.getByRole('status').filter({ hasText: 'New here?' });
    await offer.getByRole('button', { name: 'Not now' }).click();
    await expect(offer).toHaveCount(0);
    await expect.poll(() => harness.progressPuts).toEqual([{ guideId: 'welcome', status: 'dismissed' }]);
    await page.reload();
    await expect(page.locator('.page-header').first()).toBeVisible();
    await expect(offer).toHaveCount(0);
  });

  test('is not offered again to someone who has finished it', async ({ page }) => {
    await installApi(page, allPermissions, [
      { guideId: 'welcome', status: 'completed', updatedAt: '2026-11-01T10:00:00Z' },
    ]);
    await page.goto('/dashboard');
    await expect(page.locator('.page-header').first()).toBeVisible();
    await expect(page.getByText('New here?')).toHaveCount(0);
  });
});

test.describe('help center', () => {
  test('lists the four areas and finds articles by search', async ({ page }) => {
    await installApi(page, allPermissions);
    await page.goto('/help');
    for (const area of ['Getting started', 'Workshop', 'Sales & payments', 'Open days']) {
      await expect(page.getByRole('heading', { name: area, level: 2 })).toBeVisible();
    }
    await shot(page, 'help-center');
    await page.getByRole('searchbox', { name: 'Search help' }).fill('refund');
    const results = page.getByRole('region', { name: 'Search results' });
    await expect(results).toBeVisible();
    await expect(results.getByRole('heading', { name: 'Refund or correct a payment' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workshop', level: 2 })).toHaveCount(0);
    await shot(page, 'help-search');
    await page.getByRole('searchbox', { name: 'Search help' }).fill('zzzzqqqq');
    await expect(page.getByText(/Nothing in the help center matches/)).toBeVisible();
  });

  test('renders an article as Markdown', async ({ page }) => {
    await installApi(page, allPermissions);
    await page.goto('/help');
    await page.getByRole('searchbox', { name: 'Search help' }).fill('assign');
    const link = page.getByRole('region', { name: 'Search results' }).getByRole('link').first();
    const title = (await link.textContent())!;
    await link.click();
    await expect(page).toHaveURL(/\/help\/[a-z0-9-]+$/);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    // Markdown becomes real structure, not literal syntax.
    const article = page.locator('#main-content');
    await expect(article.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(article).not.toContainText('## ');
    await expect(article).not.toContainText('**');
    await shot(page, 'help-article');
    await expectNoSeriousViolations(page, '#main-content');
  });

  test('someone with only open-day permissions sees only Getting started and Open days', async ({ page }) => {
    await installApi(page, ['open_days.read', 'open_days.signup']);
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Getting started', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open days', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workshop', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sales & payments', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign up for an open day' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Assign a person to an open day' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Log a job by hand' })).toHaveCount(0);
  });

  test('help center has no serious accessibility violations', async ({ page }) => {
    await installApi(page, allPermissions);
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Open days', level: 2 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});

test.describe('tour popovers', () => {
  test('an open tour step has no serious accessibility violations', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Welcome tour');
    await expect(live(page)).toHaveText(/^Step 1 of 6/);
    await expect(panel(page)).toBeVisible({ timeout: 15_000 });
    await expectNoSeriousViolations(page);
    await panel(page).getByRole('button', { name: 'Close tour' }).click();
    await expect(panel(page)).toHaveCount(0);
  });
});

// Demo guides ---------------------------------------------------------------------------------------------------

/** Clicks the highlighted element of a click step. */
const click =
  (selector: string): StepAction =>
  async (page) => {
    await page.locator(selector).first().click();
  };

/** Opens a Carbon combobox by its input id and takes the option; `option` omitted takes the first one. */
const choose =
  (selector: string, option?: string | RegExp): StepAction =>
  async (page) => {
    await page.locator(selector).first().click();
    // The popover may cover the right part of the list; a person clicks the name at the left.
    await page
      .getByRole('option', option ? { name: option } : {})
      .first()
      .click({ position: { x: 24, y: 12 } });
    await panelNext(page);
  };

const fill =
  (selector: string, value: string): StepAction =>
  async (page) => {
    await page.locator(selector).first().fill(value);
    await panelNext(page);
  };

async function panelNext(page: Page) {
  await panel(page)
    .getByRole('button', { name: /^(Next|Done)$/ })
    .click();
}

interface DemoGuide {
  id: string;
  title: string;
  permissions?: string[];
  shots: number[];
  actions?: Record<string, StepAction>;
  /** Asserted at the last step, while the sample data is still on screen. */
  atLastStep?: (page: Page) => Promise<void>;
}

const tours: DemoGuide[] = [
  { id: 'workshop-tour', title: 'Workshop tour', shots: [0, 4, 8] },
  { id: 'sales-tour', title: 'Sales & payments tour', shots: [0, 3, 6] },
  { id: 'open-days-tour', title: 'Open days tour', shots: [0, 4, 7] },
];

const workflows: DemoGuide[] = [
  {
    id: 'workshop-log-job',
    title: 'Log a job by hand',
    shots: [0, 2, 4, -1],
    actions: {
      'Start a new job': click('[data-guide="workshop-new-job"]'),
      'Choose the machine': choose('#job-form-machine', /laser/i),
      'Choose the recipient': choose('#job-form-customer'),
      'Create the job': click('[data-guide="workshop-job-submit"]'),
    },
  },
  {
    id: 'workshop-claim-run',
    title: 'Claim a run from a machine',
    shots: [0, 2, -1],
    actions: {
      'Claim the run': click('[data-guide="workshop-claim-run"]'),
      'New job or existing job': async (page) => {
        await page.locator('label[for="claim-new"]').click();
        await panelNext(page);
      },
      'Choose the recipient': choose('#claim-customer'),
      'Name the job': fill('#claim-title', 'Bracket for the demo'),
      'Create the job': click('[data-guide="workshop-claim-submit"]'),
    },
  },
  {
    id: 'workshop-receive-stock',
    title: 'Receive stock',
    shots: [0, 2, -1],
    actions: {
      'Receive a delivery': click('[data-guide="workshop-receive-stock"]'),
      'Choose the article': choose('#receive-article', /PLA Basic Black/),
      'How much arrived': fill('#receive-count', '2'),
      'What it cost': fill('#receive-price', '39.80'),
      'Book it': click('[data-guide="workshop-receive-modal"] .cds--modal-footer .cds--btn--primary'),
    },
  },
  {
    id: 'sales-order-payment',
    title: 'Bill a finished job and take payment',
    shots: [0, 3, 5, -1],
    actions: {
      'Start from the finished jobs': click('[data-guide="orders-review"]'),
      'Select the customer’s jobs': async (page) => {
        // The step names the customer: tick Robin Sample, not just any row.
        await page
          .locator('[data-guide^="orders-ready-"]')
          .filter({ hasText: 'Robin Sample' })
          .locator('.cds--checkbox-label')
          .click();
      },
      'Create the draft': click('[data-guide="orders-ready-create"]'),
      'Finalize and take payment': click('[data-guide="order-primary"]'),
      'Record it': click('[data-guide="pay-modal"] .cds--modal-footer .cds--btn--primary'),
    },
  },
  {
    id: 'sales-reverse-payment',
    title: 'Refund or correct a payment',
    shots: [0, 3, 4, -1],
    actions: {
      'Open the payment': click('[data-guide="payments-line-PAY-0001"]'),
      'Refund or correct': click('[data-guide="payment-reverse"]'),
      'What happened?': async (page) => {
        await page.locator('label[for="reversal-refund"]').click();
        await panelNext(page);
      },
      'Give a reason': async (page) => {
        await page.locator('#reversal-reason').fill('Customer returned it');
        await panelNext(page);
      },
      'Refund the payment': click('[data-guide="reverse-modal"] .cds--modal-footer .cds--btn--danger'),
    },
  },
  {
    id: 'open-days-sign-up',
    title: 'Sign up for an open day',
    shots: [0, 1, 2, 4],
    actions: {
      'Take a place': click('[data-guide="open-days-join"]'),
      'Plans changed?': click('[data-guide="open-days-leave"]'),
      Confirm: click('.cds--modal.is-visible .cds--btn--danger'),
    },
  },
  {
    id: 'open-days-assign',
    title: 'Assign a person to an open day',
    shots: [0, 1, 2, -1],
    actions: {
      'Assign a person': click('[data-guide="open-days-assign"]'),
      'Pick someone': click('[data-guide="open-days-eligible-person"]'),
    },
  },
];

test.describe('demo guides', () => {
  for (const guide of [...tours, ...workflows]) {
    test(`${guide.id}: runs to the end in demo mode, writes nothing and returns to real data`, async ({ page }) => {
      test.setTimeout(90_000);
      const harness = await installApi(page, guide.permissions ?? allPermissions);
      await startFromHelp(page, guide.title);
      const from = harness.requests.length;
      let until = from;
      const titles = await walkGuide(page, {
        name: guide.id,
        shots: guide.shots,
        actions: guide.actions,
        atLastStep: async (current) => {
          await expect(demoBanner(current)).toBeVisible();
          until = harness.requests.length;
        },
      }).catch((error: unknown) => {
        // A crashed page hides the real cause behind the walk's timeout.
        if (harness.errors.length > 0)
          throw new Error(`${String(error)}\n\nPage errors:\n${harness.errors.join('\n')}`);
        throw error;
      });
      expect(harness.errors).toEqual([]);
      expect(titles.length).toBeGreaterThan(2);
      await expectBackToReal(page);
      expectNothingWritten(harness, from, until);
      // Real data is back: the help center asked the (mocked) server again and shows the completed tour.
      await expect(
        page.locator('.help-card').filter({ has: page.getByRole('heading', { name: guide.title, exact: true }) }),
      ).toContainText('Completed');
      expect(harness.progressPuts).toEqual([{ guideId: guide.id, status: 'completed' }]);
    });
  }
});

test.describe('narrow screens', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the welcome tour fits a phone', async ({ page }) => {
    const harness = await installApi(page, allPermissions);
    await page.goto('/dashboard');
    const offer = page.getByRole('status').filter({ hasText: 'New here?' });
    await expect(offer).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'narrow-welcome-offer');
    await offer.getByRole('button', { name: 'Start tour' }).click();
    await walkGuide(page, { name: 'narrow-welcome', shots: [0, 1, 4], narrow: true });
    await expect.poll(() => harness.progressPuts).toEqual([{ guideId: 'welcome', status: 'completed' }]);
  });

  test('a workflow demo fits a phone', async ({ page }) => {
    const harness = await installApi(page, allPermissions);
    await startFromHelp(page, 'Sign up for an open day');
    const from = harness.requests.length;
    let until = from;
    await walkGuide(page, {
      name: 'narrow-open-days-sign-up',
      shots: [0, 1, 2, 4],
      narrow: true,
      actions: {
        'Take a place': async (current) => {
          await current.locator('[data-guide="open-days-join"]').first().click();
        },
        'Plans changed?': async (current) => {
          await current.locator('[data-guide="open-days-leave"]').first().click();
        },
        Confirm: async (current) => {
          await current.locator('.cds--modal.is-visible .cds--btn--danger').first().click();
        },
      },
      atLastStep: async () => {
        until = harness.requests.length;
      },
    });
    await expectBackToReal(page);
    expectNothingWritten(harness, from, until);
    await expectNoHorizontalScroll(page);
  });
});

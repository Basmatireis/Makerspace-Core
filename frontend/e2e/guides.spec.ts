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

const openPageModal = (page: Page) =>
  page.locator('.cds--modal.is-visible:not(.guide-modal) .cds--modal-container').first();

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The popover sits next to its spotlight, or beside an open page modal without covering it. Its buttons lie inside
 * its box, and the whole popover inside the viewport.
 */
async function expectPopoverPlaced(page: Page) {
  const spotlight = page.locator('.guide-spotlight');
  await expect(spotlight).toBeVisible();
  const popover = page.locator('.guide-panel');
  await expect(popover).toBeVisible();
  await expectInViewport(page, popover);
  if (await openPageModal(page).count()) {
    await expectModalBackdropKept(page);
    const footer = page.locator('.cds--modal.is-visible:not(.guide-modal) .cds--modal-footer');
    if (await footer.count())
      await expect.poll(async () => intersects(await boxOf(popover), await boxOf(footer))).toBe(false);
    await expect
      .poll(async () => intersects(await boxOf(popover), await boxOf(openPageModal(page))), {
        message: 'popover clear of the open modal',
      })
      .toBe(false);
  } else {
    await expect
      .poll(async () => gap(await boxOf(spotlight), await boxOf(popover)), { message: 'popover next to its target' })
      .toBeLessThanOrEqual(48);
  }
  await expectButtonsInside(popover);
}

/** Carbon's own backdrop still covers the viewport and dims, and the modal is not pushed against the top edge. */
async function expectModalBackdropKept(page: Page) {
  const viewport = page.viewportSize()!;
  const backdrop = page.locator('.cds--modal.is-visible:not(.guide-modal)').first();
  const box = await boxOf(backdrop);
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, viewport.width, viewport.height]);
  const dimmed = await backdrop.evaluate((node) => {
    const color = getComputedStyle(node)
      .backgroundColor.match(/[\d.]+/g)!
      .map(Number);
    return color.length < 4 || color[3] > 0;
  });
  expect(dimmed).toBe(true);
  const modal = await boxOf(openPageModal(page));
  // Room is made only when the panel would cover the modal; with room to spare the modal stays where Carbon puts it.
  if (viewport.width >= 1000) expect(modal.y).toBeGreaterThan(0);
}

/** Every button of the panel lies fully inside the panel's box. */
async function expectButtonsInside(container: Locator) {
  // The popover may still be settling into place, so the whole comparison is repeated until it holds.
  await expect
    .poll(async () => {
      const outer = await boxOf(container);
      const buttons = container.getByRole('button');
      const count = await buttons.count();
      const outside: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible())) continue;
        const box = await boxOf(button);
        if (
          box.x < outer.x - 1 ||
          box.y < outer.y - 1 ||
          box.x + box.width > outer.x + outer.width + 1 ||
          box.y + box.height > outer.y + outer.height + 1
        ) {
          outside.push(`button ${index}`);
        }
      }
      return count > 0 ? outside : ['no buttons'];
    })
    .toEqual([]);
}

/** Each visible button of the panel is the topmost element at its centre, so nothing covers it. */
async function expectButtonsClickable(container: Locator) {
  const buttons = container.getByRole('button');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    const hit = await button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return top !== null && (node === top || node.contains(top));
    });
    expect(hit, `button "${await button.innerText()}" is covered`).toBe(true);
  }
}

/** The centered tour modal neither scrolls sideways nor lets its content run out of its box. */
async function expectCenteredModalFits(page: Page) {
  const container = page.locator('.guide-modal .cds--modal-container');
  await expectInViewport(page, container);
  const overflow = await container.evaluate((node) => {
    return [node, ...Array.from(node.querySelectorAll('*'))].filter(
      (child) => child.scrollWidth > child.clientWidth + 1 && getComputedStyle(child).overflowX !== 'visible',
    ).length;
  });
  expect(overflow).toBe(0);
  await expectNoHorizontalScroll(page);
  await expectButtonsInside(container);
}

/**
 * One full-screen dim layer covers the header, side navigation and content alike: at every probe point outside the
 * spotlight it is the topmost element, and its box is the viewport.
 */
async function expectOverlayUniform(page: Page) {
  const overlay = page.locator('.guide-overlay');
  if ((await overlay.count()) === 0) return;
  const viewport = page.viewportSize()!;
  const box = await boxOf(overlay);
  expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, viewport.width, viewport.height]);
  const probe = () =>
    page.evaluate(() => {
      const spot = document.querySelector('.guide-spotlight')!.getBoundingClientRect();
      const centre = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (!rect || rect.width < 10 || rect.right <= 0 || rect.left >= innerWidth) return null;
        return [rect.left + rect.width / 2, Math.min(rect.top + rect.height - 20, innerHeight - 20)];
      };
      const points = [
        ['top-left', [2, 2]],
        ['top-right', [innerWidth - 2, 2]],
        ['bottom-left', [2, innerHeight - 2]],
        ['bottom-right', [innerWidth - 2, innerHeight - 2]],
        ['side-nav', centre('.cds--side-nav')],
        ['content', centre('#main-content')],
      ] as const;
      return points
        .filter((entry): entry is readonly [string, number[]] => entry[1] !== null)
        .filter(
          ([, [x, y]]) => !(x >= spot.left - 6 && x <= spot.right + 6 && y >= spot.top - 6 && y <= spot.bottom + 6),
        )
        .map(([name, [x, y]]) => ({
          name,
          // Toasts sit with the modals above the dim layer by design.
          covered:
            document.elementFromPoint(x, y)?.classList.contains('guide-overlay') === true ||
            document
              .elementFromPoint(x, y)
              ?.closest('[class*="toast"], .guide-popover, .guide-dock, .guide-hole-blocker') != null,
        }));
    });
  // A drawer or the spotlight may still be moving for a moment.
  await expect
    .poll(async () => {
      const probes = await probe();
      return probes.length >= 4
        ? probes.filter((entry) => !entry.covered).map((entry) => entry.name)
        : ['too few probes'];
    })
    .toEqual([]);
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
    if (await page.locator('.guide-spotlight').count()) {
      await expectPopoverPlaced(page);
      await expectOverlayUniform(page);
    } else {
      await expectCenteredModalFits(page);
    }
    await expectInViewport(page, panel(page));
    if (options.narrow) await expectNoHorizontalScroll(page);
    if (options.shots?.includes(index) || (last && options.shots?.includes(-1))) {
      await page.waitForTimeout(150);
      await shot(page, `${options.name}-${String(index + 1).padStart(2, '0')}`);
    }
    if (last) {
      await expectButtonsClickable(panel(page));
      await options.atLastStep?.(page);
    }
    const action = options.actions?.[title];
    if (action) {
      await action(page);
    } else {
      const button = panel(page).getByRole('button', { name: last ? 'Done' : 'Next', exact: true });
      if ((await button.count()) === 0 && (await page.locator('.guide-spotlight').count()) > 0) {
        // A step that waits for the page (click or route): a person clicks the highlighted element.
        await page.waitForTimeout(500);
        const hole = await boxOf(page.locator('.guide-spotlight'));
        await page.mouse.click(hole.x + hole.width / 2, hole.y + hole.height / 2);
      } else {
        await expect(button, `step "${title}" needs an action (no Next button)`).toBeVisible();
        await button.click();
      }
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
    expect(titles.length).toBeGreaterThan(4);
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
    const title = (await link.getByRole('heading').textContent())!;
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
    await page.goto('/help/workshop-machines');
    await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('marks the open article in the topic menu and links to its neighbours', async ({ page }) => {
    await installApi(page, allPermissions);
    await page.goto('/help/workshop-machines');
    const menu = page.getByRole('navigation', { name: 'Help topics' });
    await expect(menu.getByRole('link', { name: 'Machines' })).toHaveAttribute('aria-current', 'page');
    await expect(menu.getByRole('link', { name: 'Jobs and runs' })).not.toHaveAttribute('aria-current');
    await page.getByRole('navigation', { name: 'More articles' }).getByRole('link').first().click();
    await expect(page).toHaveURL(/\/help\/workshop-/);
  });

  for (const route of ['/help', '/help/workshop-machines']) {
    test(`${route} does not scroll sideways on a phone`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installApi(page, allPermissions);
      await page.goto(route);
      await expect(page.getByRole('button', { name: 'Topics' })).toBeVisible();
      await expect(page.locator('.help-panel').first()).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      await shot(page, `help-phone-${route.split('/').pop() || 'home'}`);
      await expectNoSeriousViolations(page);
    });
  }
});

test.describe('tour popovers', () => {
  test('an open tour step has no serious accessibility violations', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Welcome tour');
    await expect(live(page)).toHaveText(/^Step 1 of \d+/);
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
    const before = (await live(page).textContent()) ?? '';
    const options = page.getByRole('option', option ? { name: option } : {});
    await page.locator(selector).first().click();
    // A field that took focus on its own may already have had its list open; the click then closed it.
    const opened = await options
      .first()
      .waitFor({ state: 'visible', timeout: 1000 })
      .then(
        () => true,
        () => false,
      );
    if (!opened) {
      await page.locator(selector).first().click();
    }
    // The popover may cover the right part of the list; a person clicks the name at the left.
    await page
      .getByRole('option', option ? { name: option } : {})
      .first()
      .click({ position: { x: 24, y: 12 } });
    await settleStep(page, before);
  };

const fill =
  (selector: string, value: string): StepAction =>
  async (page) => {
    const before = (await live(page).textContent()) ?? '';
    await page.locator(selector).first().fill(value);
    await settleStep(page, before);
  };

/**
 * After the person acted on a step: the step either moves on by itself (a `when` check) or offers Next. Takes
 * whichever comes, so the same action works for both kinds of step.
 */
async function settleStep(page: Page, before: string) {
  const next = panel(page).getByRole('button', { name: /^(Next|Done)$/ });
  await expect
    .poll(async () => (await live(page).textContent()) !== before || (await next.count()) > 0, {
      message: 'step advanced or offers Next',
    })
    .toBe(true);
  if ((await live(page).textContent()) === before) await next.click();
}

/** An action on the page after which the step moves on by itself or offers Next. */
const act =
  (action: StepAction): StepAction =>
  async (page) => {
    const before = (await live(page).textContent()) ?? '';
    await action(page);
    await settleStep(page, before);
  };

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
  { id: 'open-days-tour', title: 'Open days tour', shots: [0, 4, 7, 12] },
];

const workflows: DemoGuide[] = [
  {
    id: 'workshop-log-job',
    title: 'Log a job by hand',
    shots: [0, 2, 4, -1],
    actions: {
      'Start a new job': click('[data-guide="workshop-new-job"]'),
      'Choose the machine': choose('#job-form-machine', /laser/i),
      'Choose the recipient': choose('#job-form-customer', /Demo Robotics Club/),
      // The page's modal reaches under the side navigation at this width, so the button is pressed programmatically.
      'Add the material': async (page) => {
        await page
          .locator('[data-guide="workshop-usage-select"]')
          .first()
          .evaluate((node) => (node as HTMLElement).click());
      },
      'Choose the sheet': click('[data-guide="material-picker-row"]'),
      'How much was used': fill('#job-form-usage-0-quantity', '0.5'),
      'Create the job': click('[data-guide="workshop-job-submit"]'),
    },
  },
  {
    id: 'workshop-claim-run',
    title: 'Claim a run from a machine',
    shots: [0, 2, -1],
    actions: {
      'Claim the run': click('[data-guide="workshop-claim-run"]'),
      'New job or existing job': act(async (page) => {
        await page.locator('label[for="claim-new"]').click();
      }),
      'Choose the recipient': choose('#claim-customer', /Demo Robotics Club/),
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
      'What it cost': fill('#receive-price', '40'),
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
      'What happened?': act(async (page) => {
        await page.locator('label[for="reversal-refund"]').click();
      }),
      'Give a reason': act(async (page) => {
        await page.locator('#reversal-reason').fill('Customer returned it');
      }),
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

test.describe('engine behaviour', () => {
  test('a choice step blocks the other options and moves on by itself after the right one', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Log a job by hand');
    await expect(live(page)).toHaveText(/^Step 1 of/);
    await page
      .locator('[data-guide="workshop-new-job"]')
      .first()
      .evaluate((node) => (node as HTMLElement).click());
    await expect(live(page)).toHaveText(/^Step 2 of \d+: Choose the machine/);
    // No Next: the hint replaces it.
    await expect(panel(page).getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await expect(panel(page)).toContainText('Make your choice to move on');

    const field = page.locator('#job-form-machine');
    await field.click();
    const wrong = page.getByRole('option').filter({ hasNotText: /^Laser cutter/ });
    const right = page.getByRole('option', { name: /^Laser cutter/ });
    await expect(right.first()).toBeVisible();
    for (const option of await wrong.all()) {
      await expect(option).toHaveAttribute('aria-disabled', 'true');
      await expect(option).toHaveClass(/guide-option-disabled/);
    }
    await expect(right.first()).not.toHaveAttribute('aria-disabled', 'true');

    // Clicking a wrong option, or typing it and pressing Enter, changes nothing.
    await wrong.first().evaluate((node) => (node as HTMLElement).click());
    await field.fill('Prusa');
    await field.press('ArrowDown');
    await field.press('Enter');
    await expect(live(page)).toHaveText(/^Step 2 of/);
    // Leaving the field drops the typed text: nothing was selected.
    await page.getByRole('heading', { name: 'New job' }).click();
    await expect(field).not.toHaveValue(/Prusa|Bambu/);
    await expect(live(page)).toHaveText(/^Step 2 of/);

    await field.fill('');
    await field.click();
    await right.first().click({ position: { x: 24, y: 12 } });
    await expect(live(page)).toHaveText(/^Step 3 of \d+: /);
  });

  test('a tab bar step highlights the tabs, not the full-width bar', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Sales & payments tour');
    await expect(live(page)).toHaveText(/^Step 1 of \d+: Orders/, { timeout: 15_000 });
    const spotlight = page.locator('.guide-spotlight');
    await expect(spotlight).toBeVisible();
    const bar = await boxOf(page.locator('[data-guide="orders-tabs"]'));
    await expect.poll(async () => (await boxOf(spotlight)).width).toBeLessThan(bar.width - 40);
    const tabs = await boxOf(page.locator('[data-guide="orders-tabs"] [role="tab"]').first());
    const hole = await boxOf(spotlight);
    expect(hole.x).toBeLessThanOrEqual(tabs.x + 1);
    await shot(page, 'highlight-tabs');
  });

  test('every guide ends with clickable buttons and Done leaves demo mode', async ({ page }) => {
    const harness = await installApi(page, allPermissions);
    await startFromHelp(page, 'Receive stock');
    await walkGuide(page, {
      name: 'engine-last-step',
      actions: workflows.find((guide) => guide.id === 'workshop-receive-stock')!.actions,
    });
    await expectBackToReal(page);
    expect(harness.progressPuts).toEqual([{ guideId: 'workshop-receive-stock', status: 'completed' }]);
  });
});

test.describe('large screens', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a workflow with a page modal keeps Carbon backdrop and clear footer buttons', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Log a job by hand');
    await walkGuide(page, {
      name: 'large-log-job',
      shots: [1, 2],
      actions: workflows.find((guide) => guide.id === 'workshop-log-job')!.actions,
    });
    await expectBackToReal(page);
  });
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

  test('a workflow with a page modal keeps the panel off the modal on a phone', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Log a job by hand');
    await walkGuide(page, {
      name: 'narrow-log-job',
      shots: [0, 1, 2, 4, 5],
      narrow: true,
      actions: workflows.find((guide) => guide.id === 'workshop-log-job')!.actions,
    });
    await expectBackToReal(page);
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

test.describe('tour robustness', () => {
  /** Hides the targets of the first steps, so they wait and then show as the centered modal. */
  async function hideTargets(page: Page, ...selectors: string[]) {
    await page.evaluate((hidden) => {
      const style = document.createElement('style');
      style.textContent = `${hidden.join(',')} { display: none !important; }`;
      document.body.append(style);
    }, selectors);
  }

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    test(`the centered step is a standard small modal with a full-width footer (${viewport.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installApi(page, allPermissions);
      await startFromHelp(page, 'Workshop tour');
      await expect(live(page)).toHaveText(/^Step 1 of \d+: Jobs/, { timeout: 15_000 });
      await hideTargets(page, '[data-guide="workshop-jobs-tabs"]', '[data-guide="workshop-unassigned-strip"]');

      const modal = page.locator('.guide-modal.is-visible .cds--modal-container');
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal.getByRole('heading', { name: 'Jobs' })).toBeVisible();
      await expect(modal).toContainText(/Step 1 of \d+/);
      // The first step has no Back button; its one button is the primary action.
      await expect(modal.getByRole('button', { name: 'Back' })).toHaveCount(0);
      await expect(modal.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
      await expectCenteredModalFits(page);
      await shot(page, `robust-centered-first-${viewport.name}`);

      await modal.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(live(page)).toHaveText(/^Step 2 of \d+: Runs without a job/);
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal).toContainText('Step 2 of');

      // Back and Next share the footer: together they span it edge to edge, each about half.
      const footer = modal.locator('.cds--modal-footer');
      await expect
        .poll(async () => {
          const area = await boxOf(footer);
          const back = await boxOf(modal.getByRole('button', { name: 'Back' }));
          const next = await boxOf(modal.getByRole('button', { name: 'Next', exact: true }));
          return {
            starts: Math.abs(back.x - area.x) <= 1,
            ends: Math.abs(next.x + next.width - (area.x + area.width)) <= 1,
            equal: Math.abs(back.width - next.width) <= 2,
            touching: Math.abs(back.x + back.width - next.x) <= 1,
          };
        })
        .toEqual({ starts: true, ends: true, equal: true, touching: true });
      await expectCenteredModalFits(page);
      await expectButtonsClickable(modal);
      await shot(page, `robust-centered-second-${viewport.name}`);
    });
  }

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    test(`navigating away mid-tour says so and "Back to the tour" returns to a working step (${viewport.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installApi(page, allPermissions);
      await startFromHelp(page, 'Workshop tour');
      await expect(live(page)).toHaveText(/^Step 1 of \d+: Jobs/, { timeout: 15_000 });
      await expect(page).toHaveURL(/\/workshop\/jobs/);
      await expect(page.locator('.guide-panel')).toBeVisible();

      // The dim layer blocks real clicks outside the highlight, so the person's navigation is a programmatic click.
      await page
        .getByRole('link', { name: 'Help', exact: true })
        .first()
        .evaluate((node) => (node as HTMLElement).click());
      await expect(page).toHaveURL(/\/help/);
      const modal = page.locator('.guide-modal.is-visible .cds--modal-container');
      await expect(modal.getByRole('heading', { name: 'You left the tour' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'End tour' })).toBeVisible();
      await expectCenteredModalFits(page);
      await shot(page, `robust-left-tour-${viewport.name}`);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await expect(modal).toBeVisible();
      await shot(page, `robust-left-tour-dark-${viewport.name}`);
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

      await modal.getByRole('button', { name: 'Back to the tour' }).click();
      await expect(page).toHaveURL(/\/workshop\/jobs/);
      await expect(page.locator('.guide-panel')).toBeVisible();
      await expect(page.locator('.guide-panel')).toContainText('Jobs');
      await expect(page.locator('.guide-modal')).toHaveCount(0);
      await page.locator('.guide-panel').getByRole('button', { name: 'Next' }).click();
      await expect(live(page)).toHaveText(/^Step 2 of/);
    });
  }

  test('"End tour" on the left-the-tour dialog stops the tour', async ({ page }) => {
    await installApi(page, allPermissions);
    await startFromHelp(page, 'Workshop tour');
    await expect(live(page)).toHaveText(/^Step 1 of/, { timeout: 15_000 });
    await expect(page.locator('.guide-panel')).toBeVisible();
    await page
      .getByRole('link', { name: 'Help', exact: true })
      .first()
      .evaluate((node) => (node as HTMLElement).click());
    await page.getByRole('button', { name: 'End tour' }).click();
    await expect(page.locator('.guide-modal')).toHaveCount(0);
    await expect(live(page)).toHaveCount(0);
  });
});

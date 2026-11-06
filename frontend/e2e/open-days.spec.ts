import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  expectNoUnexpectedRequests,
  fridayA,
  fridayB,
  ids,
  installOpenDaysApi,
  makeDay,
  newWorld,
  person,
  sent,
  type World,
} from './open-days-api';

const staffing = ['open_days.read', 'open_days.signup'];
const manager = ['open_days.read', 'open_days.manage', 'open_days.assign', 'open_days.read_assignments'];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(
    results.violations.map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

async function expectNoSidewaysScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** The fixed detail panel; a docked aside from 92 rem, a bottom sheet dialog below, with the same name. */
const panelOf = (page: Page) => page.locator('aside[aria-label="Open day details"]');
const dayRow = (page: Page, name: RegExp) => page.getByRole('listitem', { name });
const FRIDAY_2 = /Friday 2 October, 16:00–19:00/;
const FRIDAY_9 = /Friday 9 October, 16:00–20:00/;
/** The add dialog is named after its period (Carbon labels the dialog with the modal label). */
const addDialog = (page: Page) =>
  page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Add open days' }) });

async function open(page: Page, world: World, path = `/open-days/${ids.period}`) {
  await installOpenDaysApi(page, world);
  await page.goto(path);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test.afterEach(() => {
  // Each world is local to its test; unexpected requests are asserted inside the tests that build one.
});

test.describe('people who sign up', () => {
  test('are sent to the current period and see no other names or internal notes', async ({ page }, testInfo) => {
    const world = newWorld({ permissions: staffing, membership: 'trainee' });
    await installOpenDaysApi(page, world);
    await page.goto('/open-days');
    await expect(page).toHaveURL(new RegExp(`/open-days/${ids.period}$`));
    await expect(page.getByRole('heading', { name: 'Open Days', level: 1 })).toBeVisible();
    // Drafts and the manager's tabs are not for them.
    await expect(page.getByRole('tab', { name: /Short-staffed/ })).toHaveCount(0);
    for (const name of [/^Upcoming/, /^Open for me/, /^Mine/, /^Past/]) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    await expect(page.getByRole('combobox', { name: 'Period' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add open days' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveCount(0);

    const row = dayRow(page, FRIDAY_2);
    await expect(row).toBeVisible();
    await expect(row.getByText('Place for you')).toBeVisible();
    await expect(page.getByText('Grace Hopper')).toHaveCount(0);
    await expect(page.getByText('Prep')).toHaveCount(0);
    await row.click();
    const panel = panelOf(page);
    await expect(panel.getByRole('heading', { name: /Friday 2 October/ })).toBeVisible();
    await expect(panel.getByText('Internal note')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Assign' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Edit this open day/ })).toHaveCount(0);
    await expectAccessible(page);
    await capture(page, testInfo, 'open-days-staff-privacy.png');
    expectNoUnexpectedRequests(world);
  });

  test('join and leave a timeslot from the panel', async ({ page }) => {
    const world = newWorld({ permissions: staffing, membership: 'trainee' });
    await open(page, world);
    await dayRow(page, FRIDAY_2).click();
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'Join as trainee' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-days/${ids.dayA}/assignments/me`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-days/${ids.dayA}/assignments/me`)[0].body).toEqual({
      requirementId: `${ids.dayA}-s0-tr`,
    });
    await expect(panel.getByText("You're in as trainee.")).toBeVisible();
    await expect(dayRow(page, FRIDAY_2).getByText(/You're in · Trainee/)).toBeVisible();
    await expect(panel.getByText('You', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect.poll(() => sent(world, 'DELETE', `/open-days/${ids.dayA}/assignments/me`).length).toBe(1);
    expect(sent(world, 'DELETE', `/open-days/${ids.dayA}/assignments/me`)[0].search).toBe(`?timeslotId=${ids.dayA}-s0`);
    await expect(panel.getByRole('button', { name: 'Join as trainee' })).toBeVisible();
    expectNoUnexpectedRequests(world);
  });

  test('join a single timeslot of a day from the list', async ({ page }) => {
    const world = newWorld({ permissions: staffing, membership: 'supervisor' });
    await open(page, world);
    const slots = page.getByRole('listitem', { name: /^Timeslot / });
    await expect(slots).toHaveCount(2);
    await dayRow(page, FRIDAY_9).click();
    await expect(panelOf(page).getByText('Sign up for one timeslot or several.')).toBeVisible();
    // The second timeslot only.
    await slots.filter({ hasText: '18:00–20:00' }).getByRole('button', { name: 'Join' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-days/${ids.dayB}/assignments/me`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-days/${ids.dayB}/assignments/me`)[0].body).toEqual({
      requirementId: `${ids.dayB}-s1-sup`,
    });
    await expect(panelOf(page).getByText("You're in for 18:00–20:00.")).toBeVisible();
    await expect(slots.filter({ hasText: '16:00–18:00' }).getByRole('button', { name: 'Join' })).toBeVisible();
    // Open for me and Mine follow the sign-up.
    await page.getByRole('tab', { name: /^Mine/ }).click();
    await expect(dayRow(page, FRIDAY_9)).toBeVisible();
    await expect(dayRow(page, FRIDAY_2)).toHaveCount(0);
    expectNoUnexpectedRequests(world);
  });

  test('a visitor-only viewer without sign-up sees the schedule without places', async ({ page }) => {
    const world = newWorld({ permissions: ['open_days.read'], membership: 'visitor' });
    await open(page, world);
    await expect(page.getByRole('tab', { name: /^Open for me/ })).toHaveCount(0);
    await expect(dayRow(page, FRIDAY_2)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join' })).toHaveCount(0);
    await expect(page.getByText('Supervisors', { exact: true })).toHaveCount(0);
    expectNoUnexpectedRequests(world);
  });
});

test.describe('the Leitung', () => {
  test('lists periods and breaks and opens the schedule from the panel', async ({ page }, testInfo) => {
    const world = newWorld({
      permissions: manager,
      days: [fridayA()],
      breaks: [
        {
          id: ids.breakId,
          name: 'Autumn break',
          startsOn: '2026-10-26',
          endsOn: '2026-11-01',
          version: 2,
          createdAt: '2026-09-14T10:00:00Z',
          updatedAt: '2026-09-14T10:00:00Z',
        },
      ],
    });
    await open(page, world, '/open-days');
    await expect(page.getByRole('heading', { name: 'Open Days', level: 1 })).toBeVisible();
    const sections = page.getByRole('tablist', { name: 'Open Days sections' });
    await expect(sections.getByRole('tab', { name: 'Periods' })).toBeVisible();
    await expect(sections.getByRole('tab', { name: 'Breaks' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Periods' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await table.getByRole('button', { name: /Winter Semester 2026\/27/ }).click();
    const panel = page.locator('aside[aria-label="Period details"]');
    await expect(panel.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
    await expectAccessible(page);
    await capture(page, testInfo, 'open-days-periods.png');
    await panel.getByRole('link', { name: 'Open schedule' }).click();
    await expect(page).toHaveURL(new RegExp(`/open-days/${ids.period}$`));
    await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Short-staffed/ })).toBeVisible();

    await page.goto('/open-days?tab=breaks');
    const breaks = page.getByRole('table', { name: 'Breaks' });
    await expect(breaks.getByRole('cell', { name: /Autumn break/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Periods' })).toHaveCount(0);
    await expectAccessible(page);
    await capture(page, testInfo, 'open-days-academic-breaks.png');
    expectNoUnexpectedRequests(world);
  });

  test('creates a period whose range spans several months', async ({ page }) => {
    const world = newWorld({ permissions: manager, periods: [], days: [] });
    await open(page, world, '/open-days');
    await page.getByRole('button', { name: 'New period' }).click();
    const form = page.locator('aside[aria-label="Period details"]');
    await form.getByLabel('Name', { exact: true }).fill('Winter semester');
    await form.getByLabel('Starts on', { exact: true }).fill('02.11.2026');
    await form.getByLabel('Ends on', { exact: true }).fill('29.01.2027');
    // Close the date picker, which would otherwise cover the button.
    await page.keyboard.press('Escape');
    await form.getByRole('button', { name: 'Create period' }).click();
    await expect.poll(() => sent(world, 'POST', '/open-day-periods').length).toBe(1);
    expect(sent(world, 'POST', '/open-day-periods')[0].body).toMatchObject({
      name: 'Winter semester',
      startsOn: '2026-11-02',
      endsOn: '2027-01-29',
      signUpDeadline: null,
    });
  });

  test('adds a day with timeslots to a working copy and saves it atomically', async ({ page }, testInfo) => {
    const world = newWorld({ permissions: manager, status: 'draft', days: [] });
    world.onSchedule = (body, state) => {
      const create = (body.creates as Array<{ timeslots: Array<{ startsAt: string; endsAt: string }> }>)[0];
      state.days.push(
        makeDay(
          ids.dayC,
          create.timeslots.map((slot) => [slot.startsAt, slot.endsAt] as [string, string]),
        ),
      );
    };
    await open(page, world);
    await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Add open days' }).click();
    const dialog = addDialog(page);
    await dialog.locator('label[for="od-add-single"]').click();
    await dialog.getByLabel('Date', { exact: true }).fill('02.10.2026');
    await dialog.locator('#od-add-start-0').fill('16:00');
    await dialog.locator('#od-add-end-0').fill('19:00');
    // Split the whole time into 1.5 hour slots: 16:00–17:30, 17:30–19:00.
    await dialog.locator('#od-add-split-amount').fill('1.5');
    await dialog.getByRole('button', { name: 'Split' }).click();
    await expect(dialog.locator('#od-add-start-1')).toHaveValue('17:30');
    await capture(page, testInfo, 'open-days-add-dialog.png');
    await dialog.getByRole('button', { name: 'Add open day', exact: true }).click();

    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar.getByText('1 unsaved change in the schedule.')).toBeVisible();
    await expect(dayRow(page, /Friday 2 October, 16:00–19:00/)).toContainText('Unsaved');
    await expect(dayRow(page, /Friday 2 October, 16:00–19:00/)).toContainText('2 timeslots');
    await capture(page, testInfo, 'open-days-manager-working-copy.png');
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)).toHaveLength(0);

    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    const saved = sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body as {
      creates: Array<{ timeslots: Array<{ startsAt: string; endsAt: string; requirements: unknown[] }> }>;
    };
    expect(saved).toMatchObject({ expectedPeriodVersion: 3, updates: [], removals: [], seriesCreates: [] });
    const [create] = saved.creates;
    expect(create.timeslots.map((slot) => [slot.startsAt, slot.endsAt])).toEqual([
      ['2026-10-02T14:00:00.000Z', '2026-10-02T15:30:00.000Z'],
      ['2026-10-02T15:30:00.000Z', '2026-10-02T17:00:00.000Z'],
    ]);
    expect(create.timeslots[0].requirements).toEqual([
      { kind: 'supervisor', requiredCount: 2, eligibleRoleIds: [] },
      { kind: 'trainee', requiredCount: 1, eligibleRoleIds: [] },
    ]);
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
    await expect(dayRow(page, /Friday 2 October, 16:00–19:00/)).not.toContainText('Unsaved');
    expectNoUnexpectedRequests(world);
  });

  test('adds a weekly series that skips holidays unless they are ticked', async ({ page }) => {
    const world = newWorld({
      permissions: manager,
      status: 'draft',
      days: [],
      entries: [
        { name: 'Allerheiligen', startsOn: '2026-11-04', endsOn: '2026-11-04', category: 'publicHoliday', source: 'x' },
      ],
    });
    await open(page, world);
    await page.getByRole('button', { name: 'Add open days' }).click();
    const dialog = addDialog(page);
    // Wednesdays between 28 October and 18 November: 28.10., 4.11. (a holiday), 11.11., 18.11.
    await dialog.getByLabel('Weekday').selectOption('3');
    await dialog.getByLabel('From', { exact: true }).fill('28.10.2026');
    await dialog.getByLabel('Until', { exact: true }).fill('18.11.2026');
    await expect(dialog.getByText('A series of 3 open days.')).toBeVisible();
    await dialog.getByRole('checkbox', { name: /Allerheiligen/ }).check({ force: true });
    await expect(dialog.getByText('A series of 4 open days.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Add series of 4 open days' }).click();

    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar).toBeVisible();
    // The days of a new series are generated in the page and shown as unsaved rows.
    await expect(page.getByRole('listitem', { name: /Wednesday 4 November/ })).toBeVisible();
    await bar.getByRole('button', { name: 'Undo last change' }).click();
    await expect(bar).toHaveCount(0);
    await page.getByRole('button', { name: 'Add open days' }).click();
    await dialog.getByLabel('Weekday').selectOption('3');
    await dialog.getByLabel('From', { exact: true }).fill('28.10.2026');
    await dialog.getByLabel('Until', { exact: true }).fill('18.11.2026');
    await dialog.getByRole('button', { name: 'Add series of 3 open days' }).click();
    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body).toMatchObject({
      creates: [],
      seriesCreates: [
        {
          weekday: 3,
          fromDate: '2026-10-28',
          untilDate: '2026-11-18',
          timeslots: [{ startTime: '17:00', endTime: '21:00' }],
          supervisorPlaces: 2,
          traineePlaces: 1,
          forcedDates: [],
        },
      ],
    });
  });

  const weeklySeries = () => ({
    id: ids.series,
    periodId: ids.period,
    weekday: 3,
    fromDate: '2026-10-07',
    untilDate: '2026-12-16',
    timeslots: [{ startTime: '17:00', endTime: '21:00' }],
    supervisorPlaces: 2,
    traineePlaces: 1,
    supervisorRoleIds: [],
    traineeRoleIds: [],
    forcedDates: [],
    dayCount: 11,
    version: 4,
    createdAt: '2026-09-14T10:00:00Z',
    updatedAt: '2026-09-14T10:00:00Z',
  });
  const wednesday = () =>
    makeDay(ids.dayC, [['2026-10-07T15:00:00Z', '2026-10-07T19:00:00Z']], { seriesId: ids.series });

  test('an edited day of a series leaves the series', async ({ page }) => {
    const world = newWorld({ permissions: manager, days: [wednesday()], series: [weeklySeries()] });
    await open(page, world);
    const row = dayRow(page, /Wednesday 7 October, 17:00–21:00/);
    await expect(row.getByText('Series')).toBeVisible();
    await row.click();
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'Edit this open day' }).click();
    await expect(panel.getByText('Saving takes this day out of its series.')).toBeVisible();
    await panel.locator('#od-day-sup').fill('3');
    await panel.getByRole('button', { name: 'Apply' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar.getByText('1 unsaved change in the schedule.')).toBeVisible();
    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body).toMatchObject({
      updates: [
        {
          id: ids.dayC,
          expectedVersion: 1,
          timeslots: [
            {
              startsAt: '2026-10-07T15:00:00.000Z',
              requirements: [{ kind: 'supervisor', requiredCount: 3 }, { kind: 'trainee' }],
            },
          ],
        },
      ],
    });
  });

  test('the whole series is edited from a date on with one series update', async ({ page }) => {
    const world = newWorld({ permissions: manager, days: [wednesday()], series: [weeklySeries()] });
    await open(page, world);
    await dayRow(page, /Wednesday 7 October/).click();
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'Edit series', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Every Wednesday' })).toBeVisible();
    await panel.locator('#od-series-sup').fill('3');
    await panel.getByLabel('Runs until', { exact: true }).fill('09.12.2026');
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: 'Apply to series' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar.getByText('1 unsaved change in the schedule.')).toBeVisible();
    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    const body = sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({
      creates: [],
      updates: [],
      seriesUpdates: [
        {
          id: ids.series,
          expectedVersion: 4,
          applyFrom: '2026-10-07',
          untilDate: '2026-12-09',
          supervisorPlaces: 3,
          traineePlaces: 1,
          timeslots: [{ startTime: '17:00', endTime: '21:00' }],
        },
      ],
    });
  });

  test('a day edited on its own can follow its series again', async ({ page }) => {
    const detached = { ...wednesday(), seriesId: null, detachedFromSeriesId: ids.series, version: 2 };
    const world = newWorld({ permissions: manager, days: [detached], series: [weeklySeries()] });
    await open(page, world);
    const row = dayRow(page, /Wednesday 7 October/);
    await expect(row.getByText('Edited separately')).toBeVisible();
    await row.click();
    await panelOf(page).getByRole('button', { name: 'Follow the series again' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body).toMatchObject({
      seriesRejoins: [{ openDayId: ids.dayC, expectedVersion: 2 }],
    });
  });

  test('changes several days together with multi-select', async ({ page }) => {
    const world = newWorld({ permissions: manager, status: 'draft', days: [fridayA(), fridayB()] });
    await open(page, world);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(panelOf(page).getByRole('heading', { name: 'Select open days' })).toBeVisible();
    await page.getByRole('listitem', { name: FRIDAY_2 }).locator('.cds--checkbox-label').click();
    await page.getByRole('listitem', { name: FRIDAY_9 }).locator('.cds--checkbox-label').click();
    const panel = panelOf(page);
    await expect(panel.getByRole('heading', { name: '2 open days selected' })).toBeVisible();
    await panel.getByText('Change supervisor places').click();
    await panel.locator('#od-bulk-sup').fill('4');
    await panel.getByRole('button', { name: 'Apply to 2 open days' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await expect(bar.getByText('2 unsaved changes in the schedule.')).toBeVisible();
    await bar.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(bar).toHaveCount(0);
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)).toHaveLength(0);
  });

  test('deletes a day of a draft period only when the schedule is saved', async ({ page }) => {
    const world = newWorld({ permissions: manager, status: 'draft', days: [fridayA()] });
    await open(page, world);
    await dayRow(page, FRIDAY_2).click();
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete open day' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 1 open day' }).click();
    const bar = page.getByRole('region', { name: 'Unsaved changes' });
    await bar.getByRole('button', { name: 'Save schedule' }).click();
    await expect.poll(() => sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`).length).toBe(1);
    expect(sent(world, 'PUT', `/open-day-periods/${ids.period}/schedule`)[0].body).toMatchObject({
      removals: [{ id: ids.dayA, expectedVersion: 1 }],
    });
  });

  test('assigns a person to a free place from the panel', async ({ page }) => {
    const world = newWorld({ permissions: [...manager, 'supervisor_dashboard.read'], days: [fridayA()] });
    world.eligible = [person(ids.grace, 'Grace Hopper')];
    await open(page, world);
    await dayRow(page, FRIDAY_2).click();
    const panel = panelOf(page);
    await panel.getByRole('button', { name: 'Assign' }).first().click();
    await expect(panel.getByRole('heading', { name: 'Assign supervisor' })).toBeVisible();
    await expect(panel.getByRole('searchbox', { name: 'Search eligible people' })).toBeVisible();
    await panel.getByText('Grace Hopper').click();
    await expect.poll(() => sent(world, 'POST', `/open-days/${ids.dayA}/assignments`).length).toBe(1);
    expect(sent(world, 'POST', `/open-days/${ids.dayA}/assignments`)[0].body).toEqual({
      requirementId: `${ids.dayA}-s0-sup`,
      personId: ids.grace,
    });
    await expect(panel.getByText('Grace Hopper', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Remove Grace Hopper' }).click();
    await expect
      .poll(
        () =>
          sent(
            world,
            'DELETE',
            /* removal of the assignment */ `/open-days/${ids.dayA}/assignments/${ids.dayA}-s0-sup-a1-other`,
          ).length,
      )
      .toBe(1);
    expectNoUnexpectedRequests(world);
  });

  test('refuses an ambiguous local time in the add dialog', async ({ page }) => {
    const world = newWorld({ permissions: manager, status: 'draft', days: [] });
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await open(page, world);
    await page.getByRole('button', { name: 'Add open days' }).click();
    const dialog = addDialog(page);
    await dialog.locator('label[for="od-add-single"]').click();
    await dialog.getByLabel('Date', { exact: true }).fill('25.10.2026');
    await dialog.locator('#od-add-start-0').fill('02:30');
    await dialog.locator('#od-add-end-0').fill('04:00');
    await dialog.getByRole('button', { name: 'Add open day', exact: true }).click();
    await expect(dialog.getByText(/Local time 25\.10\.2026 02:30 is ambiguous/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('creates and revokes the personal calendar subscription from the Open Days page link', async ({ page }) => {
  const world = newWorld({ permissions: staffing, membership: 'trainee' });
  await open(page, world, `/open-days/${ids.period}?calendar=subscription`);
  const dialog = page.locator('.cds--modal.is-visible');
  await expect(dialog.getByText('You have no calendar subscription yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create link' }).click();
  await expect(dialog.getByLabel('Subscription link')).toHaveValue(/\/api\/v1\/calendar\/secret-token\.ics$/);
  await expect.poll(() => sent(world, 'POST', '/me/calendar-feed').length).toBe(1);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await page.goto(`/open-days/${ids.period}?calendar=subscription`);
  const again = page.locator('.cds--modal.is-visible');
  await expect(again.getByText(/Your subscription is active since/)).toBeVisible();
  await again.getByRole('button', { name: 'Revoke subscription' }).click();
  await again.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect.poll(() => sent(world, 'DELETE', '/me/calendar-feed').length).toBe(1);
  expectNoUnexpectedRequests(world);
});

for (const width of [320, 390, 768, 1280, 1440]) {
  test(`list, calendar and panel fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const world = newWorld({ permissions: [...manager, 'open_days.signup'], membership: 'supervisor' });
    await open(page, world);
    await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27', level: 1 })).toBeVisible();
    await expect(dayRow(page, FRIDAY_2)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await capture(page, testInfo, `open-days-list-${width}.png`);

    await page.getByRole('button', { name: 'Show calendar' }).click();
    await expect(page.getByRole('group', { name: 'Period calendar' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Friday 2 October/ })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await capture(page, testInfo, `open-days-calendar-${width}.png`);

    // In select mode the checkbox sits in the block's second line and never covers the time.
    await page.getByRole('button', { name: 'Select' }).click();
    const block = page.getByRole('button', { name: /Friday 2 October/ });
    const time = await block.locator('.od-blk__t').boundingBox();
    const box = await block.locator('.od-check .cds--checkbox-label').boundingBox();
    expect(time && box && box.y >= time.y + time.height - 1).toBe(true);
    await capture(page, testInfo, `open-days-calendar-select-${width}.png`);
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: /Friday 2 October/ }).click();
    await expect(panelOf(page).getByRole('heading', { name: /Friday 2 October/ })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await capture(page, testInfo, `open-days-panel-${width}.png`);
  });
}

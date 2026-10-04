import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

const eventId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const sessionId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8c003';
const openRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8c004';
const roleRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8c005';
const alternateRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8c013';
const taskListId = '0192f6f8-743e-7c77-a349-cd07c3e8c006';
const taskId = '0192f6f8-743e-7c77-a349-cd07c3e8c007';
const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8c008';
const personId = '0192f6f8-743e-7c77-a349-cd07c3e8c009';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8c010';
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8c011';
const publicId = 'A'.repeat(43);
const timestamp = '2026-10-04T12:00:00Z';

function currentUser(permissions: string[]) {
  const account = {
    id: accountId,
    personId,
    loginEmail: 'ada.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: timestamp,
    authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: timestamp, disabledAt: null, usable: true, createdAt: timestamp }],
    status: 'enabled',
    passwordStatus: 'active',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    person: { id: personId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: null, roles: [], account, createdAt: timestamp, updatedAt: timestamp, version: 1 },
    account,
    permissions,
    authenticationAssurance: 'normal',
    managedDevice: null,
    delegablePermissionGrants: permissions.map((permissionId) => ({ permissionId, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' })),
    laborordnungStatus: { mode: 'not_required', state: 'not_required', actionRequired: false, currentVersion: null, latestConfirmedVersion: null, requestId: null },
  };
}

function event() {
  return {
    id: eventId,
    name: 'Autumn exhibition',
    internalDescription: 'Supplier arrival and setup notes.',
    location: 'Main workshop',
    ownerPersonId: personId,
    ownerName: 'Ada Lovelace',
    status: 'planning',
    publicTitle: 'Open workshop exhibition',
    publicDescription: 'Meet the makers.',
    publicLocation: 'Main workshop',
    publicId,
    isPublic: true,
    publicSignupEnabled: false,
    hasBanner: false,
    closedAt: null,
    rangeStartsAt: '2026-11-02T16:00:00Z',
    rangeEndsAt: '2026-11-02T22:00:00Z',
    taskTotal: 1,
    taskCompleted: 0,
    filledCount: 1,
    requiredCount: 4,
    nextDeadline: '2026-10-30T12:00:00Z',
    nextScheduleAt: '2026-11-02T14:00:00Z',
    version: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function publicEvent() {
  return {
    publicId,
    title: 'Open workshop exhibition',
    description: 'Meet the makers.',
    location: 'Main workshop',
    status: 'planning',
    timeZone: 'Europe/Vienna',
    publicSignupEnabled: true,
    hasBanner: false,
    sessions: [{ id: sessionId, name: 'Exhibition', location: 'Hall', description: 'Public programme.', startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T22:00:00Z' }],
    shifts: [{
      id: shiftId,
      sessionId: null,
      name: 'Setup',
      description: 'Prepare the hall.',
      startsAt: '2026-11-02T14:00:00Z',
      endsAt: '2026-11-02T16:00:00Z',
      requirements: [
        { id: openRequirementId, name: 'Helper', description: null, requiredCount: 3, filledCount: 1, remainingCount: 2, availability: 'available' },
        { id: alternateRequirementId, name: 'Welcome desk', description: null, requiredCount: 2, filledCount: 0, remainingCount: 2, availability: 'available' },
        { id: roleRequirementId, name: 'Specialist', description: null, requiredCount: 1, filledCount: 0, remainingCount: 1, availability: 'authenticated_only' },
      ],
    }],
    files: [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8c012', originalFilename: 'visitor-guide.pdf', description: 'Visitor guide', contentType: 'application/pdf', sizeBytes: 1024 }],
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('uses the standard table toolbar, filters, and pagination for events', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me') return json(route, currentUser(['events.read', 'events.manage']));
    if (path === '/api/v1/events') return json(route, { items: [event()] });
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  const toolbar = page.getByLabel('Events table toolbar');
  await expect(toolbar.getByRole('searchbox', { name: 'Search events' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Filters' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create event' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Staffing' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Autumn exhibition' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByRole('region', { name: 'Event filters' })).toBeVisible();
  await toolbar.getByRole('searchbox', { name: 'Search events' }).fill('missing');
  await expect(page.getByRole('heading', { name: 'No events found' })).toBeVisible();
  await toolbar.getByRole('searchbox', { name: 'Search events' }).fill('Autumn');
  await expect(page.getByRole('link', { name: 'Autumn exhibition' })).toBeVisible();
  await expectAccessible(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expectAccessible(page);
});

test('supports internal planning and staffing at desktop and narrow widths', async ({ page }) => {
  let taskStatus = 'open';
  let taskVersion = 1;
  let taskPatch: Record<string, unknown> | undefined;
  let shiftPatch: Record<string, unknown> | undefined;
  let requirementPatch: Record<string, unknown> | undefined;
  let bannerUploaded = false;
  let bannerPurpose: string | undefined;
  let bannerBodyContentType: string | undefined;
  let bannerDeclaredContentType: string | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me') return json(route, currentUser(['events.read', 'events.manage', 'events.staffing.manage', 'events.assign']));
    if (path === `/api/v1/events/${eventId}` && request.method() === 'GET') return json(route, event());
    if (path === `/api/v1/events/${eventId}` && request.method() === 'PATCH') return json(route, { code: 'validation_failed', message: 'Add a public shift with at least one requirement before enabling public signup', requestId: 'event-request' }, 422);
    if (path === `/api/v1/events/${eventId}/sessions`) return json(route, { items: [{ id: sessionId, eventId, name: 'Exhibition', location: 'Hall', description: null, startsAt: '2026-11-02T16:00:00Z', endsAt: '2026-11-02T22:00:00Z', isPublic: true, status: 'scheduled', version: 1, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/task-lists`) return json(route, { items: [{ id: taskListId, eventId, name: 'Preparation', description: null, sortOrder: 0, version: 1, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/tasks` && request.method() === 'GET') return json(route, { items: [{ id: taskId, eventId, taskListId, title: 'Prepare exhibits', description: null, status: taskStatus, priority: 'high', assigneePersonId: null, dueAt: '2026-10-30T12:00:00Z', completedAt: taskStatus === 'done' ? timestamp : null, completedByAccountId: taskStatus === 'done' ? accountId : null, sortOrder: 0, version: taskVersion, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/tasks/${taskId}` && request.method() === 'PATCH') {
      taskPatch = request.postDataJSON() as Record<string, unknown>;
      taskStatus = 'done';
      taskVersion++;
      return json(route, { ...taskPatch, id: taskId, eventId, completedAt: timestamp, completedByAccountId: accountId, version: taskVersion, createdAt: timestamp, updatedAt: timestamp });
    }
    if (path === `/api/v1/events/${eventId}/shifts`) return json(route, { items: [{ id: shiftId, eventId, sessionId: null, name: 'Setup', description: null, startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T16:00:00Z', signupOpensAt: null, signupClosesAt: null, isPublic: true, status: 'open', linkedSessionStatus: null, version: 1, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/shifts/${shiftId}` && request.method() === 'PATCH') {
      shiftPatch = request.postDataJSON() as Record<string, unknown>;
      return json(route, { ...shiftPatch, id: shiftId, eventId, linkedSessionStatus: null, version: 2, createdAt: timestamp, updatedAt: timestamp });
    }
    if (path === `/api/v1/events/${eventId}/shifts/${shiftId}/requirements`) return json(route, { items: [{ id: openRequirementId, eventId, shiftId, name: 'Helper', description: null, requiredCount: 2, filledCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/shifts/${shiftId}/requirements/${openRequirementId}` && request.method() === 'PATCH') {
      requirementPatch = request.postDataJSON() as Record<string, unknown>;
      return json(route, { ...requirementPatch, id: openRequirementId, eventId, shiftId, filledCount: 1, version: 2, createdAt: timestamp, updatedAt: timestamp });
    }
    if (path === `/api/v1/events/${eventId}/assignments`) return json(route, { items: [{ id: assignmentId, eventId, shiftId, requirementId: openRequirementId, personId: null, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'staff_entry', status: 'active', conflictOverriddenByAccountId: null, cancelledAt: null, personalDataErasedAt: null, version: 1, createdAt: timestamp, updatedAt: timestamp }] });
    if (path === `/api/v1/events/${eventId}/files` && request.method() === 'GET') return json(route, { items: bannerUploaded ? [{ id: '0192f6f8-743e-7c77-a349-cd07c3e8c014', eventId, fileId: '0192f6f8-743e-7c77-a349-cd07c3e8c015', description: null, visibility: 'public', isBanner: true, originalFilename: 'banner.png', contentType: 'image/png', sizeBytes: 68, version: 1, createdAt: timestamp, updatedAt: timestamp }] : [] });
    if (path === `/api/v1/events/${eventId}/files` && request.method() === 'POST') {
      bannerUploaded = true;
      bannerPurpose = request.headers()['x-event-file-purpose'];
      bannerBodyContentType = request.headers()['content-type'];
      bannerDeclaredContentType = request.headers()['x-file-content-type'];
      return json(route, { id: '0192f6f8-743e-7c77-a349-cd07c3e8c014', eventId, fileId: '0192f6f8-743e-7c77-a349-cd07c3e8c015', description: null, visibility: 'public', isBanner: true, originalFilename: 'banner.png', contentType: 'image/png', sizeBytes: 68, version: 1, createdAt: timestamp, updatedAt: timestamp }, 201);
    }
    if (path === `/api/v1/events/${eventId}/banner`) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    if (path === '/api/v1/event-eligibility-roles') return json(route, { items: [] });
    if (path === '/api/v1/event-people') return json(route, { items: [{ id: personId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: null }] });
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/events/${eventId}`);
  await expect(page.getByRole('heading', { name: 'Autumn exhibition' })).toBeVisible();
  await page.getByRole('tab', { name: 'Schedule' }).click();
  await page.getByRole('button', { name: 'Actions for Setup' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit shift' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Public setup');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => shiftPatch).toEqual({
    sessionId: null,
    name: 'Public setup',
    description: null,
    startsAt: '2026-11-02T14:00:00.000Z',
    endsAt: '2026-11-02T16:00:00.000Z',
    signupOpensAt: null,
    signupClosesAt: null,
    isPublic: true,
    status: 'open',
    expectedVersion: 1,
  });
  await page.getByRole('tab', { name: 'Staffing' }).click();
  await page.getByRole('button', { name: 'Actions for Helper' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit requirement' })).toBeVisible();
  await page.getByLabel('Required people').fill('3');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => requirementPatch).toEqual({
    name: 'Helper',
    description: null,
    requiredCount: 3,
    eligibilityMode: 'anyone',
    eligibleRoleIds: [],
    expectedVersion: 1,
  });
  await page.getByRole('tab', { name: 'Planning' }).click();
  await page.getByLabel('Mark Prepare exhibits complete').evaluate((checkbox: HTMLInputElement) => checkbox.click());
  await expect.poll(() => taskPatch).toEqual({ taskListId, title: 'Prepare exhibits', description: null, status: 'done', priority: 'high', assigneePersonId: null, dueAt: '2026-10-30T12:00:00Z', sortOrder: 0, expectedVersion: 1 });
  await page.getByRole('tab', { name: 'Staffing' }).click();
  await expect(page.getByLabel('Helper staffing')).toBeVisible();
  await expect(page.getByText('Grace Hopper')).toBeVisible();
  await page.getByRole('button', { name: 'Assign helper' }).click();
  await expect(page.getByLabel('Override a scheduling conflict (audited)')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText(/Before enabling signup, add a public shift in Schedule/)).toBeVisible();
  await page.locator('#event-banner-upload').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByAltText('Event banner preview')).toBeVisible();
  await page.getByRole('button', { name: 'Upload banner' }).click();
  await expect.poll(() => bannerPurpose).toBe('banner');
  expect(bannerBodyContentType).toBe('application/octet-stream');
  expect(bannerDeclaredContentType).toBe('image/png');
  await page.getByLabel('Public signup').check({ force: true });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Add a public shift with at least one requirement before enabling public signup')).toBeVisible();
  await page.getByRole('tab', { name: 'Staffing' }).click();
  await expectAccessible(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Staffing' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expectAccessible(page);
});

test('creates an anonymous signup and keeps its management token in the URL fragment only', async ({ page }) => {
  const token = 'private-event-management-token-1234567890';
  let signupBody: Record<string, unknown> | undefined;
  let moveBody: Record<string, unknown> | undefined;
  let receivedToken: string | null = null;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me') return json(route, { code: 'invalid_session', message: 'Sign in required.' }, 401);
    if (path === `/api/v1/public/events/${publicId}`) return json(route, publicEvent());
    if (path === `/api/v1/public/events/${publicId}/signups` && request.method() === 'POST') {
      signupBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { assignment: { id: assignmentId, publicId, shiftId, requirementId: openRequirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'public_signup', status: 'active', cancelledAt: null, version: 1, createdAt: timestamp, updatedAt: timestamp }, managementUrl: `/events/signup/manage#token=${token}` }, 201);
    }
    if (path === '/api/v1/public/event-signups/current' && request.method() === 'GET') {
      receivedToken = request.headers()['x-event-signup-token'] ?? null;
      return json(route, { id: assignmentId, publicId, shiftId, requirementId: openRequirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'public_signup', status: 'active', cancelledAt: null, version: 1, createdAt: timestamp, updatedAt: timestamp });
    }
    if (path === '/api/v1/public/event-signups/current' && request.method() === 'PATCH') {
      receivedToken = request.headers()['x-event-signup-token'] ?? null;
      moveBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { id: assignmentId, publicId, shiftId, requirementId: alternateRequirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test', phone: null, source: 'public_signup', status: 'active', cancelledAt: null, version: 2, createdAt: timestamp, updatedAt: timestamp });
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/events/public/${publicId}`);
  await expect(page.getByText('1 / 3 filled')).toBeVisible();
  await expect(page.getByText('Supplier arrival and setup notes.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign up' }).first().click();
  await page.getByLabel('Shift and requirement').selectOption(`${shiftId}:${openRequirementId}`);
  await page.getByLabel('First name').fill('Grace');
  await page.getByLabel('Last name').fill('Hopper');
  await page.getByLabel('Email').fill('grace@example.test');
  await page.getByRole('button', { name: 'Confirm signup' }).click();
  const managementURL = await page.getByLabel('One-time management link').inputValue();
  expect(signupBody).toMatchObject({ shiftId, requirementId: openRequirementId, firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' });
  expect(managementURL).toContain(`#token=${token}`);
  await expectAccessible(page);

  await page.goto(managementURL);
  await expect(page.getByRole('heading', { name: 'Your signup' })).toBeVisible();
  expect(receivedToken).toBe(token);
  expect(page.url()).not.toContain(token);
  await expect(page.getByText(token)).toHaveCount(0);
  await page.getByLabel('Move to another place').selectOption(`${shiftId}:${alternateRequirementId}`);
  await page.getByRole('button', { name: 'Move signup' }).click();
  await expect.poll(() => moveBody).toEqual({ shiftId, requirementId: alternateRequirementId, expectedVersion: 1 });
  expect(receivedToken).toBe(token);
});

test('supports authenticated self and on-behalf public signup without exposing role names', async ({ page }) => {
  const requests: Array<Record<string, unknown>> = [];
  let ownAssignments: unknown[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me') return json(route, currentUser([]));
    if (path === `/api/v1/public/events/${publicId}`) return json(route, publicEvent());
    if (path === `/api/v1/events/public/${publicId}/assignments/me`) return json(route, { items: ownAssignments });
    if (path === `/api/v1/events/public/${publicId}/signups` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const external = body.signupFor === 'other';
      const assignment = { id: assignmentId, publicId, shiftId, requirementId: body.requirementId, firstName: body.firstName, lastName: body.lastName, email: body.email, phone: body.phone ?? null, source: external ? 'authenticated_on_behalf' : 'authenticated_self', status: 'active', cancelledAt: null, version: 1, createdAt: timestamp, updatedAt: timestamp };
      if (!external) ownAssignments = [assignment];
      return json(route, { assignment, managementUrl: external ? '/events/signup/manage#token=on-behalf-secret' : null }, 201);
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/events/public/${publicId}`);
  await expect(page.getByText('authenticated only')).toBeVisible();
  await expect(page.getByText(/eligible role/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign up' }).first().click();
  await page.getByLabel('Shift and requirement').selectOption(`${shiftId}:${roleRequirementId}`);
  await page.getByRole('button', { name: 'Confirm signup' }).click();
  await expect(page.getByText('Your signup has been added to this event.')).toBeVisible();

  await page.getByLabel('Someone else').check({ force: true });
  await expect(page.getByLabel('Shift and requirement').locator(`option[value="${shiftId}:${roleRequirementId}"]`)).toBeDisabled();
  await page.getByLabel('Shift and requirement').selectOption(`${shiftId}:${openRequirementId}`);
  await page.getByLabel('First name').fill('Katherine');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Email').fill('katherine@example.test');
  await page.getByRole('button', { name: 'Confirm signup' }).click();
  await expect(page.getByLabel('One-time management link')).toHaveValue(/#token=on-behalf-secret$/);
  expect(requests).toMatchObject([
    { signupFor: 'self', requirementId: roleRequirementId },
    { signupFor: 'other', requirementId: openRequirementId, firstName: 'Katherine', lastName: 'Johnson', email: 'katherine@example.test' },
  ]);
  await expectAccessible(page);
});

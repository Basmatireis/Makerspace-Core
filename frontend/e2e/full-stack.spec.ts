import { expect, test } from '@playwright/test';

const masterLogin = 'e2e-master@example.test';
const masterPassword = 'E2E master workshop passphrase 42';
const memberLogin = 'e2e-supervisor@example.test';
const memberPassword = 'E2E supervisor workshop passphrase 57';

test.skip(
  process.env.PLAYWRIGHT_FULL_STACK !== 'true',
  'Run through make test-e2e against the isolated Go/PostgreSQL stack.',
);

test.describe.configure({ mode: 'serial' });

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function signOut(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /Open profile menu for/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('runs the bootstrapped administration, redaction, self-service, and hard-delete vertical slice', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let personPath = '';
  let rolePath = '';

  await test.step('sign in with the CLI-bootstrap fixture and reach Dashboard', async () => {
    await signIn(page, masterLogin, masterPassword);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Welcome, E2E.')).toBeVisible();
  });

  await test.step('create, configure, and edit a custom supervisor role', async () => {
    await page.goto('/settings/roles/new');
    await expect(page.getByRole('heading', { name: 'Create role' })).toBeVisible();
    const createRoleDialog = page.getByRole('dialog');
    await createRoleDialog.getByLabel('Role name').fill('E2E workshop supervisors');
    await createRoleDialog
      .getByLabel('Description')
      .fill('Browser-tested limited administration role.');
    await createRoleDialog.getByRole('button', { name: 'Create role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);

    await page.getByRole('button', { name: /Edit View all people for E2E workshop supervisors/ }).click();
    await page.getByLabel('Permission enabled').click({ force: true });
    await page.getByLabel('Minimum authentication assurance').selectOption('normal');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /Edit View all people for E2E workshop supervisors: Normal assurance/ })).toBeVisible();

    await page.getByRole('button', { name: /Edit Edit own profile for E2E workshop supervisors/ }).click();
    await page.getByLabel('Permission enabled').click({ force: true });
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.getByRole('tab', { name: 'Effective permissions' }).click();
    await page.getByLabel('Authentication assurance').selectOption('low');
    await expect(page.getByRole('button', { name: /View View all people for E2E workshop supervisors: Not granted in this context/ })).toBeVisible();
    await page.getByLabel('Authentication assurance').selectOption('normal');
    await expect(page.getByRole('button', { name: /View View all people for E2E workshop supervisors: Granted in this context/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Configuration' }).click();

    await page.getByRole('button', { name: 'Actions for E2E workshop supervisors' }).click();
    await page.getByRole('menuitem', { name: 'Edit role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles\/[0-9a-f-]+$/);
    rolePath = new URL(page.url()).pathname;
    const editRoleDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Edit role' }) });
    await editRoleDialog
      .getByLabel('Description')
      .fill('Browser-tested supervisor role with redacted sensitive fields.');
    await editRoleDialog.getByRole('button', { name: 'Save role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);
  });

  await test.step('create a Person and provision, enable, and assign its Account', async () => {
    await page.goto('/settings/users/new');
    await page.getByLabel('First name').fill('Katherine');
    await page.getByLabel('Last name').fill('Johnson');
    await page.getByLabel('Contact email').fill('e2e-contact@example.test');
    await page.getByLabel('Matriculation number').fill('E2E-MAT-2042');
    await page.getByRole('button', { name: 'Create member' }).click();
    await expect(page).toHaveURL(/\/settings\/users\/[0-9a-f-]+$/);
    personPath = new URL(page.url()).pathname;
    await expect(
      page.getByRole('heading', { name: 'Katherine Johnson' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Create account' }).click();
    const createAccountDialog = page.getByRole('dialog', {
      name: 'Katherine Johnson',
    });
    await createAccountDialog.getByLabel('Login email').fill(memberLogin);
    await createAccountDialog
      .getByRole('button', { name: 'Create account' })
      .click();
    await expect(createAccountDialog).toBeHidden();
    await expect(
      page.getByRole('paragraph').filter({ hasText: memberLogin }),
    ).toBeVisible();

    // Direct administrator password setting is an emergency API operation and
    // intentionally no longer appears in normal UI workflows. Exercise it
    // explicitly here so this fixture can continue through member sign-in.
    const origin = new URL(page.url()).origin;
    const createdPersonId = personPath.split('/').at(-1)!;
    const personResponse = await page.request.get(`${origin}/api/v1/people/${createdPersonId}`);
    expect(personResponse.ok()).toBeTruthy();
    const person = await personResponse.json() as { account: { id: string; version: number } };
    const csrfCookie = (await page.context().cookies()).find((cookie) => cookie.name.includes('csrf'));
    expect(csrfCookie).toBeDefined();
    const passwordResponse = await page.request.put(`${origin}/api/v1/accounts/${person.account.id}/password`, {
      headers: { Origin: origin, 'X-CSRF-Token': csrfCookie!.value },
      data: { newPassword: memberPassword, expectedVersion: person.account.version },
    });
    expect(passwordResponse.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByText('Enabled', { exact: true }).last()).toBeVisible();

    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.getByText('enabled', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Assign role' }).click();
    const assignRoleDialog = page.getByRole('dialog');
    await assignRoleDialog.getByText('Choose a role').click();
    await page.getByRole('option', { name: 'E2E workshop supervisors' }).click();
    await assignRoleDialog.getByRole('button', { name: 'Assign role' }).click();
    await expect(
      page
        .getByLabel('Assigned roles')
        .getByText('E2E workshop supervisors', { exact: true }),
    ).toBeVisible();
  });

  await test.step('verify supervisor redaction and self-only profile editing', async () => {
    await signOut(page);
    await signIn(page, memberLogin, memberPassword);

    await page.goto('/settings/users');
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Matriculation number' }),
    ).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Account' })).toHaveCount(0);
    await expect(page.getByText('E2E-MAT-2042')).toHaveCount(0);

    await page.getByRole('link', { name: 'E2E Administrator' }).click();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

    await page.goto('/profile');
    await page.getByRole('button', { name: 'Edit profile' }).click();
    await page.getByLabel('Phone').fill('+43 316 555 2042');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('+43 316 555 2042')).toBeVisible();
    await expect(page.getByText('Matriculation number')).toHaveCount(0);
  });

  await test.step('hard-delete the Person and delete the custom Role', async () => {
    await signOut(page);
    await signIn(page, masterLogin, masterPassword);

    await page.goto(personPath);
    await page.getByRole('button', { name: 'Delete member' }).click();
    await expect(page.getByText('Delete member permanently?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete member' }).last().click();
    await expect(page).toHaveURL(/\/settings\/users$/);
    await expect(page.getByText('Katherine Johnson')).toHaveCount(0);

    await page.goto(rolePath);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Actions for E2E workshop supervisors' }).click();
    await page.getByRole('menuitem', { name: 'Delete role' }).click();
    await expect(page.getByRole('heading', { name: 'Delete role?' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles$/);
    await expect(page.getByText('E2E workshop supervisors')).toHaveCount(0);
  });
});

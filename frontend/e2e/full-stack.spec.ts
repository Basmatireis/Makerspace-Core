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

  await test.step('create and edit a custom supervisor role', async () => {
    await page.goto('/settings/roles/new');
    await expect(page.getByRole('heading', { name: 'Create role' })).toBeVisible();
    await page.getByLabel('Role name').fill('E2E workshop supervisors');
    await page
      .getByLabel('Description')
      .fill('Browser-tested limited administration role.');
    await page.getByLabel('people · read · all').check({ force: true });
    await page.getByLabel('people · update · self').check({ force: true });
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(page).toHaveURL(/\/settings\/roles\/[0-9a-f-]+$/);
    rolePath = new URL(page.url()).pathname;
    await expect(
      page.getByRole('heading', { name: 'E2E workshop supervisors' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page
      .getByLabel('Description')
      .fill('Browser-tested supervisor role with redacted sensitive fields.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('Browser-tested supervisor role with redacted sensitive fields.'),
    ).toBeVisible();
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

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Set password' }).click();
    const passwordDialog = page.getByRole('dialog');
    await passwordDialog.getByLabel('New password').fill(memberPassword);
    await passwordDialog.getByLabel('Confirm password').fill(memberPassword);
    await passwordDialog.getByRole('button', { name: 'Set password' }).click();
    await expect(passwordDialog).toBeHidden();
    await expect(page.getByText('active', { exact: true })).toBeVisible();

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
    await page.getByRole('button', { name: 'Delete role' }).click();
    await expect(page.getByText('Delete this role?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete role' }).last().click();
    await expect(page).toHaveURL(/\/settings\/roles$/);
    await expect(page.getByText('E2E workshop supervisors')).toHaveCount(0);
  });
});

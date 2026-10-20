import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId, type Organization, type PricingGroup } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const now = '2026-09-15T11:26:00Z';
const organizationId = '0192f6f8-743e-7c77-a349-cd07c3e8a915';
const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a916';
const otherPersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a917';
const groupId = '0192f6f8-743e-7c77-a349-cd07c3e8a930';
const organization: Organization = {
  id: organizationId,
  name: 'Atelier GmbH',
  kind: 'company',
  active: true,
  addressLine: 'Hauptstr. 1',
  postalCode: '1010',
  locality: 'Wien',
  countryCode: 'AT',
  contactName: 'Erika Muster',
  contactEmail: 'erika@atelier.example.test',
  memberCount: 1,
  pricingGroupAssignmentVersion: 0,
  version: 4,
  createdAt: now,
  updatedAt: now,
};
const group: PricingGroup = {
  id: groupId,
  name: 'Partners',
  description: null,
  active: true,
  isDefault: false,
  version: 2,
  createdAt: now,
  updatedAt: now,
  rules: [],
};

function as(...permissions: PermissionId[]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/pricing-groups', () => HttpResponse.json({ items: [group] })),
  );
}

describe('Organizations list', () => {
  it('lists organizations, sends search and filters to the API, and hides creation without manage', async () => {
    const requests: URL[] = [];
    as(PermissionId.organizationsread, PermissionId.pricingread);
    server.use(
      http.get('*/api/v1/organizations', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [organization], page: 1, pageSize: 10, total: 1 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/organizations');
    expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Atelier GmbH' })).toHaveAttribute(
      'href',
      `/organizations/${organizationId}`,
    );
    expect(screen.queryByRole('button', { name: 'New organization' })).not.toBeInTheDocument();
    const breadcrumbs = within(screen.getByLabelText('Breadcrumb'));
    expect(breadcrumbs.getByText('Directory')).toBeInTheDocument();

    await user.click(
      screen
        .getByText('Filters', { selector: '.cds--tooltip-content' })
        .closest('.cds--popover-container')!
        .querySelector('button') as HTMLElement,
    );
    await user.click(screen.getByRole('radio', { name: 'Institute' }));
    await user.click(screen.getByRole('radio', { name: 'Inactive' }));
    await user.click(screen.getByRole('radio', { name: 'Partners' }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      const last = requests.at(-1)!;
      expect(last.searchParams.get('kind')).toBe('institute');
      expect(last.searchParams.get('active')).toBe('false');
      expect(last.searchParams.get('pricingGroupId')).toBe(groupId);
    });
    await user.type(screen.getByRole('searchbox'), 'Atel');
    await waitFor(() => expect(requests.at(-1)!.searchParams.get('search')).toBe('Atel'));
  });

  it('creates an organization for organizations.manage and opens its page', async () => {
    let body: Record<string, unknown> | undefined;
    as(PermissionId.organizationsread, PermissionId.organizationsmanage);
    server.use(
      http.get('*/api/v1/organizations', () => HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 })),
      http.get(`*/api/v1/organizations/${organizationId}`, () => HttpResponse.json(organization)),
      http.get(`*/api/v1/organizations/${organizationId}/members`, () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/organizations', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(organization, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/organizations');
    await user.click((await screen.findAllByRole('button', { name: 'New organization' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), ' Atelier GmbH ');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'institute');
    await user.click(within(dialog).getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(body).toEqual({ name: 'Atelier GmbH', kind: 'institute' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/organizations/${organizationId}`));
  });

  it('keeps the page closed without organizations.read', async () => {
    as(PermissionId.pricingread);
    const { router } = renderRoute(<App />, '/organizations');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });
});

describe('Organization page', () => {
  function serve(overrides: { requirePo?: boolean } = {}) {
    const calls: {
      organization?: Record<string, unknown>;
      requirements?: Record<string, unknown>;
      pricing?: Record<string, unknown>;
      added?: Record<string, unknown>;
      removed?: string;
    } = {};
    server.use(
      http.get(`*/api/v1/organizations/${organizationId}`, () => HttpResponse.json(organization)),
      http.get(`*/api/v1/organizations/${organizationId}/members`, () =>
        HttpResponse.json({ items: [{ personId, displayName: 'Maria Hoffmann', addedAt: now }] }),
      ),
      http.get(`*/api/v1/organizations/${organizationId}/invoicing-requirements`, () =>
        HttpResponse.json({ requirePurchaseOrderReference: overrides.requirePo ?? false, version: 2 }),
      ),
      http.get('*/api/v1/billing-parties', () =>
        HttpResponse.json({
          items: [
            { kind: 'person', id: personId, displayName: 'Maria Hoffmann', pricingGroupAssignmentVersion: 0 },
            { kind: 'person', id: otherPersonId, displayName: 'Jonas Weber', pricingGroupAssignmentVersion: 0 },
            { kind: 'organization', id: organizationId, displayName: 'Atelier GmbH', pricingGroupAssignmentVersion: 0 },
          ],
        }),
      ),
      http.patch(`*/api/v1/organizations/${organizationId}`, async ({ request }) => {
        calls.organization = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...organization, version: 5 });
      }),
      http.put(`*/api/v1/organizations/${organizationId}/invoicing-requirements`, async ({ request }) => {
        calls.requirements = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ requirePurchaseOrderReference: true, version: 3 });
      }),
      http.put('*/api/v1/billing-party-pricing-group', async ({ request }) => {
        calls.pricing = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`*/api/v1/organizations/${organizationId}/members`, async ({ request }) => {
        calls.added = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { personId: otherPersonId, displayName: 'Jonas Weber', addedAt: now },
          { status: 201 },
        );
      }),
      http.delete(`*/api/v1/organizations/${organizationId}/members/${personId}`, () => {
        calls.removed = personId;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return calls;
  }

  it('shows master data, invoice data and people read-only for organizations.read', async () => {
    as(
      PermissionId.organizationsread,
      PermissionId.ordersread,
      PermissionId.machine_jobsread,
      PermissionId.peoplereadall,
    );
    serve({ requirePo: true });
    renderRoute(<App />, `/organizations/${organizationId}`);
    expect(await screen.findByRole('heading', { name: 'Atelier GmbH' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Address')).toHaveValue('Hauptstr. 1');
    expect(screen.getByLabelText('Contact email')).toHaveValue('erika@atelier.example.test');
    expect(await screen.findByRole('switch', { name: /Purchase order number required/ })).toBeChecked();
    expect(await screen.findByRole('link', { name: 'Maria Hoffmann' })).toHaveAttribute('href', `/people/${personId}`);
    expect(screen.getByRole('link', { name: 'Show jobs' })).toHaveAttribute(
      'href',
      `/machine-logbook/jobs?customer=${organizationId}`,
    );
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Remove /, { selector: '.cds--tooltip-content' })).not.toBeInTheDocument();
  });

  it('saves master data and invoice data with the loaded version and the purchase-order flag separately', async () => {
    as(PermissionId.organizationsread, PermissionId.organizationsmanage, PermissionId.ordersread);
    const calls = serve();
    const user = userEvent.setup();
    renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Atelier Wien GmbH');
    await user.click(screen.getByRole('button', { name: 'Save master data' }));
    await waitFor(() =>
      expect(calls.organization).toEqual({
        name: 'Atelier Wien GmbH',
        kind: 'company',
        active: true,
        expectedVersion: 4,
      }),
    );

    calls.organization = undefined;
    await user.clear(await screen.findByLabelText('Contact person'));
    await user.type(screen.getByLabelText('Contact person'), 'Max Muster');
    await user.click(await screen.findByRole('switch', { name: /Purchase order number required/ }));
    await user.click(screen.getByRole('button', { name: 'Save invoice data' }));
    await waitFor(() =>
      expect(calls.organization).toMatchObject({
        name: 'Atelier GmbH',
        expectedVersion: 4,
        addressLine: 'Hauptstr. 1',
        postalCode: '1010',
        locality: 'Wien',
        countryCode: 'AT',
        contactName: 'Max Muster',
        contactEmail: 'erika@atelier.example.test',
      }),
    );
    await waitFor(() =>
      expect(calls.requirements).toEqual({ requirePurchaseOrderReference: true, expectedVersion: 2 }),
    );
  });

  it('rejects an invalid country code and email before saving', async () => {
    as(PermissionId.organizationsread, PermissionId.organizationsmanage);
    const calls = serve();
    const user = userEvent.setup();
    renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });
    await user.clear(screen.getByLabelText(/Country code/));
    await user.type(screen.getByLabelText(/Country code/), 'A');
    await user.click(screen.getByRole('button', { name: 'Save invoice data' }));
    expect(await screen.findByText('Use a two-letter country code.')).toBeInTheDocument();
    expect(calls.organization).toBeUndefined();
  });

  it('assigns a pricing group with the assignment version, and adds and removes people', async () => {
    as(
      PermissionId.organizationsread,
      PermissionId.organizationsmanage,
      PermissionId.pricingread,
      PermissionId.pricingmanage,
    );
    const calls = serve();
    const user = userEvent.setup();
    renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });

    await user.selectOptions(await screen.findByLabelText('Pricing group'), groupId);
    await waitFor(() =>
      expect(calls.pricing).toEqual({
        party: { kind: 'organization', id: organizationId },
        pricingGroupId: groupId,
        expectedVersion: 0,
      }),
    );

    await user.click(screen.getByPlaceholderText('Search people'));
    // Existing members and organizations are not offered.
    expect(screen.queryByRole('option', { name: 'Atelier GmbH' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Maria Hoffmann' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Jonas Weber' }));
    await user.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(calls.added).toEqual({ personId: otherPersonId }));

    await user.click(
      (await screen.findByText('Remove Maria Hoffmann', { selector: '.cds--tooltip-content' }))
        .closest('.cds--popover-container')!
        .querySelector('button') as HTMLElement,
    );
    await waitFor(() => expect(calls.removed).toBe(personId));
  });
});

describe('Delete organization', () => {
  function serveDetail() {
    server.use(
      http.get(`*/api/v1/organizations/${organizationId}`, () => HttpResponse.json(organization)),
      http.get(`*/api/v1/organizations/${organizationId}/members`, () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/organizations', () => HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 })),
    );
  }

  it('is not offered without organizations.manage', async () => {
    as(PermissionId.organizationsread);
    serveDetail();
    renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });
    expect(screen.queryByRole('button', { name: 'Delete organization' })).not.toBeInTheDocument();
  });

  it('confirms in a danger dialog, sends the loaded version, then returns to the list with a toast', async () => {
    let body: Record<string, unknown> | undefined;
    as(PermissionId.organizationsread, PermissionId.organizationsmanage);
    serveDetail();
    server.use(
      http.delete(`*/api/v1/organizations/${organizationId}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });
    await user.click(screen.getByRole('button', { name: 'Delete organization' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this organization?')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 4 }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/organizations'));
    expect(await screen.findByText('Organization deleted')).toBeInTheDocument();
  });

  it('cancels without deleting', async () => {
    const deleted = vi.fn();
    as(PermissionId.organizationsread, PermissionId.organizationsmanage);
    serveDetail();
    server.use(
      http.delete(`*/api/v1/organizations/${organizationId}`, () => {
        deleted();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });
    await user.click(screen.getByRole('button', { name: 'Delete organization' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(deleted).not.toHaveBeenCalled();
  });

  it('shows organization_in_use inline with the hint to deactivate and stays on the page', async () => {
    as(PermissionId.organizationsread, PermissionId.organizationsmanage);
    serveDetail();
    server.use(
      http.delete(`*/api/v1/organizations/${organizationId}`, () =>
        HttpResponse.json({ code: 'organization_in_use', message: 'in use' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/organizations/${organizationId}`);
    await screen.findByRole('heading', { name: 'Atelier GmbH' });
    await user.click(screen.getByRole('button', { name: 'Delete organization' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }));
    expect(await within(dialog).findByText(/Deactivate it instead/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete organization' })).toBeDisabled();
    expect(router.state.location.pathname).toBe(`/organizations/${organizationId}`);
  });
});
